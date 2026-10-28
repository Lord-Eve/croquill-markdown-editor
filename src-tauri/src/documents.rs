use base64::{engine::general_purpose::STANDARD, Engine};
use percent_encoding::percent_decode_str;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};

const MAX_DOCUMENT_BYTES: u64 = 64 * 1024 * 1024;
const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;
static SAVE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Serialize)]
pub struct Document {
    pub path: String,
    pub text: String,
    pub bom: bool,
    pub newline: String,
    pub revision: String,
}

#[derive(Debug, Serialize)]
pub struct WriteResult {
    pub revision: String,
}

fn revision(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn display_path(path: &Path) -> String {
    let value = path.to_string_lossy();
    if let Some(unc) = value.strip_prefix("\\\\?\\UNC\\") {
        format!("\\\\{unc}")
    } else {
        value.strip_prefix("\\\\?\\").unwrap_or(&value).to_string()
    }
}

fn detect_newline(text: &str) -> &'static str {
    let crlf = text.contains("\r\n");
    let rest = text.replace("\r\n", "");
    let lf = rest.contains('\n');
    let cr = rest.contains('\r');
    match (crlf, lf, cr) {
        (true, false, false) => "crlf",
        (false, false, true) => "cr",
        (false, _, false) => "lf",
        _ => "mixed",
    }
}

fn encode_document(text: &str, bom: bool, newline: &str) -> Result<Vec<u8>, String> {
    let text = match newline {
        "mixed" => text.to_owned(),
        "lf" | "crlf" | "cr" => {
            let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
            match newline {
                "crlf" => normalized.replace('\n', "\r\n"),
                "cr" => normalized.replace('\n', "\r"),
                _ => normalized,
            }
        }
        _ => return Err("未知换行格式，未写入文件。".into()),
    };
    let mut bytes = Vec::with_capacity(text.len() + if bom { 3 } else { 0 });
    if bom {
        bytes.extend_from_slice(&[0xef, 0xbb, 0xbf]);
    }
    bytes.extend_from_slice(text.as_bytes());
    Ok(bytes)
}

pub fn read_document(path: &str) -> Result<Document, String> {
    let path = fs::canonicalize(path).map_err(|e| format!("无法打开文件：{e}"))?;
    let metadata = fs::metadata(&path).map_err(|e| format!("无法读取文件信息：{e}"))?;
    if !metadata.is_file() {
        return Err("请选择普通 Markdown 文件。".into());
    }
    if metadata.len() > MAX_DOCUMENT_BYTES {
        return Err("文件超过 64 MB，请使用更适合超大文件的编辑器。".into());
    }
    let bytes = fs::read(&path).map_err(|e| format!("读取文件失败：{e}"))?;
    let bom = bytes.starts_with(&[0xef, 0xbb, 0xbf]);
    let content = if bom { &bytes[3..] } else { &bytes };
    let text = std::str::from_utf8(content)
        .map_err(|_| "文件不是有效的 UTF-8 编码。请先以 UTF-8 编码另存，再打开。".to_string())?
        .to_owned();
    Ok(Document {
        path: display_path(&path),
        newline: detect_newline(&text).into(),
        text,
        bom,
        revision: revision(&bytes),
    })
}

fn resolve_destination(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("保存路径必须是绝对路径。".into());
    }
    if path.exists() {
        let resolved = fs::canonicalize(path).map_err(|e| format!("无法解析保存路径：{e}"))?;
        if !resolved.is_file() {
            return Err("保存目标不是普通文件。".into());
        }
        Ok(resolved)
    } else {
        let parent = path.parent().ok_or("保存路径缺少文件夹。")?;
        let parent = fs::canonicalize(parent).map_err(|e| format!("保存文件夹不可用：{e}"))?;
        let name = path.file_name().ok_or("保存路径缺少文件名。")?;
        Ok(parent.join(name))
    }
}

pub fn write_document(
    path: &str,
    text: &str,
    bom: bool,
    newline: &str,
    expected_revision: Option<&str>,
) -> Result<WriteResult, String> {
    let _guard = SAVE_LOCK.lock().map_err(|_| "保存服务不可用，请重新启动编辑器。")?;
    let path = resolve_destination(Path::new(path))?;
    let bytes = encode_document(text, bom, newline)?;
    let previous = if path.exists() {
        Some(fs::read(&path).map_err(|e| format!("无法读取原文件，未执行覆盖：{e}"))?)
    } else {
        None
    };
    if let Some(expected) = expected_revision {
        match previous.as_ref() {
            Some(old) if revision(old) == expected => {}
            _ => return Err("原文件已被其他程序修改或移走。当前内容已保留，请另存为以避免覆盖。".into()),
        }
    }
    let result = WriteResult { revision: revision(&bytes) };
    if previous.as_deref() == Some(bytes.as_slice()) {
        return Ok(result);
    }
    if path.exists()
        && fs::metadata(&path).map_err(|e| format!("无法读取原文件权限：{e}"))?.permissions().readonly()
    {
        return Err("文件为只读，原文件未修改。请另存为其他文件。".into());
    }
    let parent = path.parent().ok_or("保存路径无效。")?;
    let mut temporary = tempfile::Builder::new()
        .prefix(".croquill-save-")
        .suffix(".tmp")
        .tempfile_in(parent)
        .map_err(|e| format!("无法创建保存临时文件，原文件未修改：{e}"))?;
    temporary.write_all(&bytes).map_err(|e| format!("写入临时文件失败，原文件未修改：{e}"))?;
    temporary.as_file().sync_all().map_err(|e| format!("同步临时文件失败，原文件未修改：{e}"))?;
    let temporary = temporary.into_temp_path();
    replace_file(&temporary, &path, previous.is_some())?;
    // TempPath cleanup is harmless after its file has atomically moved to the destination.
    Ok(result)
}

#[cfg(windows)]
fn replace_file(temporary: &Path, target: &Path, existing: bool) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, ReplaceFileW, MOVEFILE_WRITE_THROUGH};
    fn wide(path: &Path) -> Vec<u16> {
        path.as_os_str().encode_wide().chain(std::iter::once(0)).collect()
    }
    let temporary_wide = wide(temporary);
    let target_wide = wide(target);
    if !existing {
        // No REPLACE_EXISTING: a file appearing after the initial check is never overwritten.
        let success = unsafe { MoveFileExW(temporary_wide.as_ptr(), target_wide.as_ptr(), MOVEFILE_WRITE_THROUGH) };
        return if success != 0 { Ok(()) } else { Err(format!("保存新文件失败，内容仍保留在编辑器：{}", std::io::Error::last_os_error())) };
    }
    // ReplaceFileW preserves the existing file's Windows ACL. A same-directory backup
    // also covers the documented partial-failure cases of ReplaceFileW.
    let backup = tempfile::Builder::new().prefix(".croquill-backup-").suffix(".tmp")
        .tempfile_in(target.parent().ok_or("保存路径无效。")?)
        .map_err(|e| format!("无法创建安全备份，原文件未修改：{e}"))?
        .into_temp_path();
    let backup_wide = wide(&backup);
    let success = unsafe {
        ReplaceFileW(target_wide.as_ptr(), temporary_wide.as_ptr(), backup_wide.as_ptr(), 0, std::ptr::null_mut(), std::ptr::null_mut())
    };
    if success != 0 {
        return Ok(());
    }
    let error = std::io::Error::last_os_error();
    if !target.exists() && backup.exists() {
        let restored = unsafe { MoveFileExW(backup_wide.as_ptr(), target_wide.as_ptr(), MOVEFILE_WRITE_THROUGH) };
        if restored == 0 {
            let backup_path = backup.keep().map_err(|e| format!("保存失败且恢复原文件失败：{error}；{e}"))?;
            return Err(format!("保存失败且自动恢复受阻。原文件安全备份位于 {}；当前编辑内容仍保留。错误：{error}", display_path(&backup_path)));
        }
    }
    Err(format!("替换文件失败，当前编辑内容已保留：{error}"))
}

#[cfg(not(windows))]
fn replace_file(temporary: &Path, target: &Path, existing: bool) -> Result<(), String> {
    if !existing && target.exists() {
        return Err("保存目标已被其他程序创建，请重选文件名。".into());
    }
    fs::rename(temporary, target).map_err(|e| format!("原子替换失败：{e}"))
}

pub fn read_local_image(document_path: &str, src: &str) -> Result<String, String> {
    let path_part = src.split(['?', '#']).next().unwrap_or(src);
    let decoded = percent_decode_str(path_part).decode_utf8().map_err(|_| "图片路径编码无效。")?;
    let decoded = decoded.as_ref();
    let local = if let Some(file_path) = decoded.strip_prefix("file://") {
        let file_path = file_path.strip_prefix("localhost/").map(|value| format!("/{value}")).unwrap_or_else(|| file_path.to_owned());
        if !file_path.starts_with('/') {
            return Err("不支持远程 file URL，请使用本地图片路径。".into());
        }
        #[cfg(windows)]
        let file_path = if file_path.as_bytes().get(2) == Some(&b':') { file_path[1..].to_owned() } else { file_path };
        file_path
    } else {
        let drive = decoded.as_bytes().get(1) == Some(&b':')
            && decoded.as_bytes().first().is_some_and(u8::is_ascii_alphabetic);
        if decoded.contains(':') && !drive {
            return Err("仅支持本地图片文件路径。".into());
        }
        decoded.to_owned()
    };
    if local.starts_with("\\\\") || local.starts_with("//") {
        return Err("首版不读取网络共享图片，请使用本地路径。".into());
    }
    let local = Path::new(&local);
    let resolved = if local.is_absolute() {
        local.to_path_buf()
    } else {
        let doc = fs::canonicalize(document_path).map_err(|e| format!("图片所对应文档不可用：{e}"))?;
        doc.parent().ok_or("文档没有所在文件夹。")?.join(local)
    };
    let path = fs::canonicalize(resolved).map_err(|e| format!("无法读取本地图片：{e}"))?;
    let metadata = fs::metadata(&path).map_err(|e| format!("无法读取图片信息：{e}"))?;
    if !metadata.is_file() || metadata.len() > MAX_IMAGE_BYTES {
        return Err("图片不可用或超过 20 MB。".into());
    }
    let extension = path.extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase();
    let mime = match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        _ => return Err("不支持这种本地图片格式。".into()),
    };
    let bytes = fs::read(path).map_err(|e| format!("读取图片失败：{e}"))?;
    Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file_path(directory: &tempfile::TempDir, name: &str) -> String {
        directory.path().join(name).to_string_lossy().into_owned()
    }

    #[test]
    fn utf8_bom_crlf_and_chinese_space_path_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let path = file_path(&dir, "中文 写作.md");
        let text = "# 标题\r\n\r\n中文，标点。\r\n";
        write_document(&path, text, true, "crlf", None).unwrap();
        let read = read_document(&path).unwrap();
        assert_eq!(read.text, text);
        assert!(read.bom);
        assert_eq!(read.newline, "crlf");
        let before = fs::read(&path).unwrap();
        write_document(&path, &read.text, read.bom, &read.newline, Some(&read.revision)).unwrap();
        assert_eq!(fs::read(path).unwrap(), before);
    }

    #[test]
    fn replacement_and_conflict_preserve_external_contents() {
        let dir = tempfile::tempdir().unwrap();
        let path = file_path(&dir, "document.md");
        write_document(&path, "original", false, "lf", None).unwrap();
        let read = read_document(&path).unwrap();
        write_document(&path, "edited\n", false, "lf", Some(&read.revision)).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "edited\n");
        assert!(write_document(&path, "stale", false, "lf", Some(&read.revision)).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "edited\n");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn readonly_and_missing_directory_fail_without_changes() {
        let dir = tempfile::tempdir().unwrap();
        let path = file_path(&dir, "readonly.md");
        fs::write(&path, "original").unwrap();
        let mut permissions = fs::metadata(&path).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&path, permissions).unwrap();
        assert!(write_document(&path, "changed", false, "lf", None).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "original");
        let mut permissions = fs::metadata(&path).unwrap().permissions();
        permissions.set_readonly(false);
        fs::set_permissions(&path, permissions).unwrap();
        assert!(write_document(&file_path(&dir, "missing/doc.md"), "draft", false, "lf", None).is_err());
    }

    #[test]
    fn invalid_utf8_is_rejected_and_mixed_newlines_are_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let path = file_path(&dir, "mixed.md");
        let original = b"one\r\ntwo\nthree\rfour";
        fs::write(&path, original).unwrap();
        let doc = read_document(&path).unwrap();
        assert_eq!(doc.newline, "mixed");
        write_document(&path, &doc.text, doc.bom, &doc.newline, Some(&doc.revision)).unwrap();
        assert_eq!(fs::read(&path).unwrap(), original);
        fs::write(&path, [0xff, 0xfe, 0]).unwrap();
        assert!(read_document(&path).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn windows_locked_target_replacement_preserves_original() {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ;
        let dir = tempfile::tempdir().unwrap();
        let path = file_path(&dir, "locked.md");
        fs::write(&path, "original").unwrap();
        let held = fs::OpenOptions::new().read(true).share_mode(FILE_SHARE_READ).open(&path).unwrap();
        assert!(write_document(&path, "new content", false, "lf", None).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "original");
        drop(held);
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn relative_absolute_and_file_url_image_resolution() {
        let dir = tempfile::tempdir().unwrap();
        let document_dir = dir.path().join("中文 文件夹");
        fs::create_dir(&document_dir).unwrap();
        let document = document_dir.join("test.md");
        fs::write(&document, "").unwrap();
        fs::write(document_dir.join("a b.png"), [137, 80, 78, 71]).unwrap();
        fs::write(dir.path().join("outside.png"), [137, 80, 78, 71]).unwrap();
        assert!(read_local_image(document.to_str().unwrap(), "a%20b.png").unwrap().starts_with("data:image/png;base64,"));
        assert!(read_local_image(document.to_str().unwrap(), "../outside.png").is_ok());
        let absolute = document_dir.join("a b.png");
        assert!(read_local_image("", absolute.to_str().unwrap()).is_ok());
        let url_path = absolute.to_string_lossy().replace('\\', "/").replace(' ', "%20");
        let absolute_url = format!("file://{}{}", if url_path.starts_with('/') { "" } else { "/" }, url_path);
        assert!(read_local_image("", &absolute_url).is_ok());
        assert!(read_local_image(document.to_str().unwrap(), "https://example.com/x.png").is_err());
        assert!(read_local_image(document.to_str().unwrap(), "file://server/share/x.png").is_err());
    }
}
