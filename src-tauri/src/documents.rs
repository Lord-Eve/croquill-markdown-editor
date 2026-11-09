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

pub fn document_exists(path: &str) -> Result<bool, String> {
    match fs::metadata(path) {
        Ok(metadata) => Ok(metadata.is_file()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("无法检查文件是否存在：{error}")),
    }
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
    let temporary = stage_bytes(parent, &bytes)?;
    replace_file(&temporary, &path, previous.is_some())?;
    // TempPath cleanup is harmless after its file has atomically moved to the destination.
    Ok(result)
}

// Markdown saves and image imports share the same synced, same-directory staging path.
fn stage_bytes(parent: &Path, bytes: &[u8]) -> Result<tempfile::TempPath, String> {
    let mut temporary = tempfile::Builder::new()
        .prefix(".croquill-save-")
        .suffix(".tmp")
        .tempfile_in(parent)
        .map_err(|e| format!("无法创建保存临时文件，原文件未修改：{e}"))?;
    temporary.write_all(bytes).map_err(|e| format!("写入临时文件失败，原文件未修改：{e}"))?;
    temporary.as_file().sync_all().map_err(|e| format!("同步临时文件失败，原文件未修改：{e}"))?;
    Ok(temporary.into_temp_path())
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

fn image_mime(path: &Path) -> Result<&'static str, String> {
    let extension = path.extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase();
    match extension.as_str() {
        "png" => Ok("image/png"),
        "jpg" | "jpeg" => Ok("image/jpeg"),
        "gif" => Ok("image/gif"),
        "webp" => Ok("image/webp"),
        "bmp" => Ok("image/bmp"),
        "svg" => Ok("image/svg+xml"),
        "avif" => Ok("image/avif"),
        _ => Err("不支持这种本地图片格式。".into()),
    }
}

fn sanitize_image_name(name: &str) -> String {
    let mut name: String = name.chars().filter(|character| {
        !character.is_control() && !"<>:\"/\\|?*".contains(*character)
    }).collect();
    while name.contains("..") {
        name = name.replace("..", "");
    }
    name = name.trim_matches([' ', '.']).to_owned();
    if name.is_empty() {
        return "image.png".into();
    }
    let base = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    if matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (base.len() == 4 && (base.starts_with("COM") || base.starts_with("LPT"))
            && matches!(base.as_bytes()[3], b'1'..=b'9'))
    {
        name.insert(0, '_');
    }
    name
}

fn encode_image_component(value: &str) -> String {
    let mut encoded = String::new();
    for character in value.chars() {
        if !character.is_ascii() && !character.is_whitespace() && !character.is_control() || character.is_ascii_alphanumeric() || "-._~".contains(character) {
            encoded.push(character);
        } else {
            let mut utf8 = [0; 4];
            for byte in character.encode_utf8(&mut utf8).as_bytes() { encoded.push_str(&format!("%{byte:02X}")); }
        }
    }
    encoded
}

fn image_destination(assets: &Path, name: &str) -> Result<PathBuf, String> {
    let relative = Path::new(name);
    if relative.components().count() != 1
        || !matches!(relative.components().next(), Some(std::path::Component::Normal(_)))
        || name.contains(['/', '\\'])
    {
        return Err("图片目标路径越出附件文件夹，已拒绝写入。".into());
    }
    let destination = assets.join(relative);
    if destination.parent() != Some(assets) {
        return Err("图片目标路径越出附件文件夹，已拒绝写入。".into());
    }
    Ok(destination)
}

fn validate_assets_directory(assets: &Path, parent: &Path) -> Result<PathBuf, String> {
    let metadata = fs::symlink_metadata(assets).map_err(|e| format!("无法读取附件文件夹：{e}"))?;
    #[cfg(windows)]
    let is_link = {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0 // FILE_ATTRIBUTE_REPARSE_POINT includes junctions.
    };
    #[cfg(not(windows))]
    let is_link = metadata.file_type().is_symlink();
    if is_link || !metadata.is_dir() {
        return Err("附件位置不是普通文件夹，或路径越出文档目录，已拒绝写入。".into());
    }
    let resolved = fs::canonicalize(assets).map_err(|e| format!("无法解析附件文件夹：{e}"))?;
    if resolved.parent() != Some(parent) {
        return Err("附件路径越出文档目录，已拒绝写入。".into());
    }
    Ok(resolved)
}

pub fn import_image(
    document_path: &str,
    source_path: Option<&str>,
    data_base64: Option<&str>,
    file_name: Option<&str>,
) -> Result<String, String> {
    let _guard = SAVE_LOCK.lock().map_err(|_| "保存服务不可用，请重新启动编辑器。")?;
    let document = Path::new(document_path);
    if !document.is_absolute() {
        return Err("请先保存文档，再插入图片。".into());
    }
    let document = fs::canonicalize(document).map_err(|e| format!("请先保存文档，再插入图片：{e}"))?;
    if !document.is_file() {
        return Err("图片所对应文档不是普通文件。".into());
    }
    let parent = document.parent().ok_or("文档没有所在文件夹。")?;
    let assets_name = format!("{}.assets", document.file_stem().ok_or("文档缺少文件名。")?.to_string_lossy());
    let assets = parent.join(&assets_name);
    let (name, bytes) = match (source_path, data_base64) {
        (Some(source), None) => {
            let source = Path::new(source);
            if !source.is_absolute() {
                return Err("图片来源必须是本地绝对路径。".into());
            }
            let name = source.file_name().and_then(|name| name.to_str()).ok_or("图片来源缺少有效文件名。")?;
            let metadata = fs::metadata(source).map_err(|e| format!("无法读取图片信息：{e}"))?;
            if !metadata.is_file() || metadata.len() > MAX_IMAGE_BYTES {
                return Err("图片不可用或超过 20 MB。".into());
            }
            (sanitize_image_name(name), fs::read(source).map_err(|e| format!("读取图片失败：{e}"))?)
        }
        (None, Some(data)) => {
            if data.len() as u64 > MAX_IMAGE_BYTES.div_ceil(3) * 4 {
                return Err("图片超过 20 MB。".into());
            }
            let bytes = STANDARD.decode(data).map_err(|_| "剪贴板图片编码无效。")?;
            (sanitize_image_name(file_name.ok_or("剪贴板图片缺少文件名。")?), bytes)
        }
        _ => return Err("请提供一种图片来源。".into()),
    };
    if bytes.is_empty() || bytes.len() as u64 > MAX_IMAGE_BYTES {
        return Err("图片不可用或超过 20 MB。".into());
    }
    image_mime(Path::new(&name))?;
    match fs::create_dir(&assets) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(format!("无法创建附件文件夹：{error}")),
    }
    let resolved_assets = validate_assets_directory(&assets, parent)?;
    let stem = Path::new(&name).file_stem().and_then(|stem| stem.to_str()).ok_or("图片缺少文件名。")?;
    let extension = Path::new(&name).extension().and_then(|extension| extension.to_str()).ok_or("图片缺少扩展名。")?;
    for suffix in 0..10000 {
        let candidate = if suffix == 0 { name.clone() } else { format!("{stem}-{suffix}.{extension}") };
        let destination = image_destination(&resolved_assets, &candidate)?;
        // symlink_metadata also counts dangling links as collisions, never replacing them.
        if fs::symlink_metadata(&destination).is_ok() {
            continue;
        }
        let temporary = stage_bytes(&resolved_assets, &bytes)?;
        if validate_assets_directory(&assets, parent)? != resolved_assets {
            return Err("附件文件夹在写入前发生变化，已拒绝写入。".into());
        }
        match replace_file(&temporary, &destination, false) {
            Ok(()) => return Ok(format!("{}/{}", encode_image_component(&assets_name), encode_image_component(&candidate))),
            Err(_) if fs::symlink_metadata(&destination).is_ok() => continue,
            Err(error) => return Err(format!("图片未插入：{error}")),
        }
    }
    Err("同名图片过多，请重命名来源图片后重试。".into())
}

fn local_image_path(src: &str) -> Result<PathBuf, String> {
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
    Ok(PathBuf::from(local))
}

pub fn read_local_image(document_path: &str, src: &str) -> Result<String, String> {
    let local = local_image_path(src)?;
    let resolved = if local.is_absolute() {
        local
    } else {
        let doc = fs::canonicalize(document_path).map_err(|e| format!("图片所对应文档不可用：{e}"))?;
        doc.parent().ok_or("文档没有所在文件夹。")?.join(local)
    };
    let path = fs::canonicalize(resolved).map_err(|e| format!("无法读取本地图片：{e}"))?;
    let metadata = fs::metadata(&path).map_err(|e| format!("无法读取图片信息：{e}"))?;
    if !metadata.is_file() || metadata.len() > MAX_IMAGE_BYTES {
        return Err("图片不可用或超过 20 MB。".into());
    }
    let mime = image_mime(&path)?;
    let bytes = fs::read(path).map_err(|e| format!("读取图片失败：{e}"))?;
    Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

fn relative_image_path(from: &Path, target: &Path) -> Option<PathBuf> {
    let from: Vec<_> = from.components().collect();
    let target: Vec<_> = target.components().collect();
    let equal = |left: &std::path::Component<'_>, right: &std::path::Component<'_>| {
        if cfg!(windows) { left.as_os_str().to_string_lossy().eq_ignore_ascii_case(&right.as_os_str().to_string_lossy()) } else { left == right }
    };
    if !equal(from.first()?, target.first()?) { return None; }
    let common = from.iter().zip(&target).take_while(|(left, right)| equal(left, right)).count();
    let mut relative = PathBuf::new();
    for _ in common..from.len() { relative.push(".."); }
    for component in target.iter().skip(common) { relative.push(component.as_os_str()); }
    Some(relative)
}
fn image_path_url(path: &Path, absolute: bool) -> Result<String, String> {
    let path = display_path(path);
    let path = if cfg!(windows) { path.replace('\\', "/") } else { path };
    if path.starts_with("//") { return Err("暂不支持跨网络共享目录迁移图片路径，原文档已保留。".into()); }
    let mut result = String::new();
    for (index, component) in path.split('/').enumerate() {
        if index > 0 { result.push('/'); }
        if absolute && index == 0 && component.len() == 2 && component.ends_with(':') { result.push_str(component); }
        else { result.push_str(&encode_image_component(component)); }
    }
    Ok(if absolute { if result.starts_with('/') { format!("file://{result}") } else { format!("file:///{result}") } } else { result })
}

/// Save As retains the original files and rewrites only image destinations.
/// None means the original reference still resolves to the same file: leave its
/// spelling untouched. All validation happens before the Markdown safe write.
pub fn rebase_image_paths(from_path: &str, to_path: &str, sources: &[String]) -> Result<Vec<Option<String>>, String> {
    let from = Path::new(from_path); let to = Path::new(to_path);
    if !from.is_absolute() || !to.is_absolute() { return Err("另存为的文档路径必须为绝对路径。".into()); }
    let local: Vec<_> = sources.iter().map(|source| local_image_path(source)).collect::<Result<_, _>>()?;
    if local.iter().all(|path| path.is_absolute()) { return Ok(vec![None; sources.len()]); }
    let original = match fs::canonicalize(from) {
        Ok(document) => document,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && fs::symlink_metadata(from).is_err() => from.to_path_buf(),
        Err(error) => return Err(format!("无法确定原文档的图片基准位置：{error}")),
    };
    let from = fs::canonicalize(original.parent().ok_or("原文档没有所在目录。")?).map_err(|e| format!("原文档目录不可用：{e}"))?;
    // The writer and image reader follow an existing file link. Use precisely
    // that destination, not merely the directory selected in the dialog.
    let destination = resolve_destination(to)?;
    let to = destination.parent().ok_or("保存目标没有所在目录。")?.to_path_buf();
    if from == to { return Ok(vec![None; sources.len()]); }
    sources.iter().zip(local).map(|(source, local)| {
        // A rooted Windows path without a drive (e.g. /images/a.png) still
        // depends on the original document's drive and must be rebased.
        if local.is_absolute() { return Ok(None); }
        let image = fs::canonicalize(from.join(&local)).map_err(|e| format!("图片不可用，尚未另存为：{source}；{e}"))?;
        let metadata = fs::metadata(&image).map_err(|e| format!("无法检查图片，尚未另存为：{e}"))?;
        if !metadata.is_file() || metadata.len() > MAX_IMAGE_BYTES { return Err(format!("图片不可用或超过 20 MB，尚未另存为：{source}")); }
        image_mime(&image)?;
        if fs::canonicalize(to.join(local)).is_ok_and(|destination| destination == image) { return Ok(None); }
        match relative_image_path(&to, &image) {
            Some(relative) => image_path_url(&relative, false).map(Some),
            None => image_path_url(&image, true).map(Some),
        }
    }).collect()
}

#[cfg(test)]
mod save_as_tests {
    use super::*;

    #[test]
    fn moving_the_document_rebases_to_the_same_original_image_without_copy_or_move() {
        let temp = tempfile::tempdir().unwrap();
        let old = temp.path().join("原目录"); let new = temp.path().join("新目录");
        fs::create_dir(&old).unwrap(); fs::create_dir(&new).unwrap(); fs::create_dir(old.join("原文.assets")).unwrap();
        let source = old.join("原文.md"); let target = new.join("新文.md"); let image = old.join("原文.assets/中文 图片.png");
        fs::write(&source, b"original").unwrap(); fs::write(&image, b"original image").unwrap();
        fs::create_dir(new.join("原文.assets")).unwrap(); fs::write(new.join("原文.assets/中文 图片.png"), b"different image").unwrap();
        let paths = rebase_image_paths(source.to_str().unwrap(), target.to_str().unwrap(), &["原文.assets/中文%20图片.png?raw=1#view".into()]).unwrap();
        assert_eq!(paths, vec![Some("../原目录/原文.assets/中文%20图片.png".into())]);
        // Simulate the sole Markdown write; the image reader must resolve the
        // rebased path from the saved document, not from an in-memory cache.
        write_document(target.to_str().unwrap(), "new Markdown", false, "lf", None).unwrap();
        let displayed = read_local_image(target.to_str().unwrap(), paths[0].as_ref().unwrap()).unwrap();
        assert_eq!(displayed, format!("data:image/png;base64,{}", STANDARD.encode(b"original image")));
        assert_eq!(fs::read(source).unwrap(), b"original"); assert_eq!(fs::read(image).unwrap(), b"original image");
        assert_eq!(fs::read(new.join("原文.assets/中文 图片.png")).unwrap(), b"different image");
    }

    #[test]
    fn same_directory_and_shared_relative_targets_keep_their_exact_source_spelling() {
        let temp = tempfile::tempdir().unwrap();
        let a = temp.path().join("a"); let b = temp.path().join("b"); fs::create_dir(&a).unwrap(); fs::create_dir(&b).unwrap();
        fs::write(temp.path().join("shared.png"), b"image").unwrap();
        assert_eq!(rebase_image_paths(a.join("a.md").to_str().unwrap(), a.join("renamed.md").to_str().unwrap(), &["./missing%20image.png".into()]).unwrap(), vec![None]);
        assert_eq!(rebase_image_paths(a.join("a.md").to_str().unwrap(), b.join("b.md").to_str().unwrap(), &["../shared.png".into()]).unwrap(), vec![None]);
        assert_eq!(rebase_image_paths(a.join("a.md").to_str().unwrap(), b.join("b.md").to_str().unwrap(), &[temp.path().join("shared.png").to_string_lossy().into_owned()]).unwrap(), vec![None]);
    }

    #[test]
    fn encoded_filename_characters_are_not_mistaken_for_fragment_delimiters() {
        let temp = tempfile::tempdir().unwrap(); let a = temp.path().join("a"); let b = temp.path().join("b"); fs::create_dir(&a).unwrap(); fs::create_dir(&b).unwrap();
        fs::write(a.join("a#1.png"), b"image").unwrap();
        assert_eq!(rebase_image_paths(a.join("a.md").to_str().unwrap(), b.join("b.md").to_str().unwrap(), &["a%231.png#view".into()]).unwrap(), vec![Some("../a/a%231.png".into())]);
        fs::write(a.join("中文　图.png"), b"image").unwrap();
        assert_eq!(rebase_image_paths(a.join("a.md").to_str().unwrap(), b.join("b.md").to_str().unwrap(), &["中文　图.png".into()]).unwrap(), vec![Some("../a/中文%E3%80%80图.png".into())]);
    }

    #[test]
    fn missing_or_oversized_images_fail_before_any_document_or_attachment_write() {
        let temp = tempfile::tempdir().unwrap(); let a = temp.path().join("a"); let b = temp.path().join("b"); fs::create_dir(&a).unwrap(); fs::create_dir(&b).unwrap();
        let source = a.join("old.md"); let target = b.join("new.md"); fs::write(&source, b"original").unwrap();
        assert!(rebase_image_paths(source.to_str().unwrap(), target.to_str().unwrap(), &["missing.png".into()]).is_err());
        fs::File::create(a.join("huge.png")).unwrap().set_len(MAX_IMAGE_BYTES + 1).unwrap();
        assert!(rebase_image_paths(source.to_str().unwrap(), target.to_str().unwrap(), &["huge.png".into()]).is_err());
        assert!(!target.exists()); assert_eq!(fs::read(source).unwrap(), b"original"); assert_eq!(fs::read_dir(b).unwrap().count(), 0);
    }

    #[test]
    fn existence_check_distinguishes_missing_files_and_directories() {
        let temp = tempfile::tempdir().unwrap(); let file = temp.path().join("文档.md");
        assert!(!document_exists(file.to_str().unwrap()).unwrap()); fs::write(&file, b"text").unwrap(); assert!(document_exists(file.to_str().unwrap()).unwrap());
        assert!(!document_exists(temp.path().to_str().unwrap()).unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn document_links_use_the_same_real_directory_as_the_safe_writer_and_image_reader() {
        let temp = tempfile::tempdir().unwrap();
        let old = temp.path().join("old"); let target = temp.path().join("target"); let links = temp.path().join("links");
        for directory in [&old, &target, &links] { fs::create_dir(directory).unwrap(); }
        fs::create_dir(old.join("assets")).unwrap(); fs::write(old.join("assets/picture.png"), b"original image").unwrap();
        fs::write(old.join("note.md"), b"original document").unwrap(); fs::write(target.join("copy.md"), b"target document").unwrap();
        let source_alias = links.join("source.md"); let target_alias = links.join("target.md");
        std::os::unix::fs::symlink(old.join("note.md"), &source_alias).unwrap(); std::os::unix::fs::symlink(target.join("copy.md"), &target_alias).unwrap();
        let paths = rebase_image_paths(source_alias.to_str().unwrap(), target_alias.to_str().unwrap(), &["assets/picture.png".into()]).unwrap();
        assert_eq!(paths, vec![Some("../old/assets/picture.png".into())]);
        write_document(target_alias.to_str().unwrap(), "saved copy", false, "lf", None).unwrap();
        assert_eq!(read_local_image(target_alias.to_str().unwrap(), paths[0].as_ref().unwrap()).unwrap(), format!("data:image/png;base64,{}", STANDARD.encode(b"original image")));
        assert_eq!(fs::read(old.join("note.md")).unwrap(), b"original document");
        assert_eq!(fs::read(target.join("copy.md")).unwrap(), b"saved copy");
    }

    #[cfg(windows)]
    #[test]
    fn cross_drive_images_use_an_escaped_local_file_url() {
        assert!(relative_image_path(Path::new("D:\\new"), Path::new("C:\\old\\图 片.png")).is_none());
        assert_eq!(image_path_url(Path::new("C:\\old\\图 片.png"), true).unwrap(), "file:///C:/old/图%20片.png");
    }
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
    fn image_import_creates_assets_and_never_overwrites_collisions() {
        let dir = tempfile::tempdir().unwrap();
        let document = file_path(&dir, "日记.md");
        fs::write(&document, "original document").unwrap();
        for suffix in 0..3 {
            let bytes = vec![137, 80, 78, 71, suffix];
            let encoded = STANDARD.encode(&bytes);
            let relative = import_image(&document, None, Some(&encoded), Some("photo.png")).unwrap();
            let expected = if suffix == 0 { "photo.png".to_owned() } else { format!("photo-{suffix}.png") };
            assert_eq!(relative, format!("日记.assets/{expected}"));
            assert_eq!(fs::read(dir.path().join("日记.assets").join(expected)).unwrap(), bytes);
        }
        assert_eq!(fs::read_to_string(&document).unwrap(), "original document");
        assert_eq!(fs::read_dir(dir.path().join("日记.assets")).unwrap().count(), 3);
        assert_eq!(fs::read(dir.path().join("日记.assets/photo.png")).unwrap(), [137, 80, 78, 71, 0]);
    }

    #[test]
    fn local_image_import_keeps_chinese_name_and_roundtrips_encoded_special_characters() {
        let dir = tempfile::tempdir().unwrap();
        let document = file_path(&dir, "日记 # %空格.md");
        let source = file_path(&dir, "图片 空格%#().png");
        let bytes = [137, 80, 78, 71];
        fs::write(&document, "").unwrap();
        fs::write(&source, bytes).unwrap();
        let relative = import_image(&document, Some(&source), None, None).unwrap();
        assert_eq!(relative, "日记%20%23%20%25空格.assets/图片%20空格%25%23%28%29.png");
        assert_eq!(fs::read(dir.path().join("日记 # %空格.assets/图片 空格%#().png")).unwrap(), bytes);
        assert_eq!(fs::read(&source).unwrap(), bytes);
        assert_eq!(read_local_image(&document, &relative).unwrap(), format!("data:image/png;base64,{}", STANDARD.encode(bytes)));
    }

    #[test]
    fn image_names_remove_traversal_and_windows_illegal_characters() {
        assert_eq!(sanitize_image_name(r#"../..\bad<>:"/|?*name.png. "#), "badname.png");
        assert_eq!(sanitize_image_name("CON.png"), "_CON.png");
        assert_eq!(sanitize_image_name("lpt9.png"), "_lpt9.png");
        assert_eq!(sanitize_image_name(".. /\\"), "image.png");
        let dir = tempfile::tempdir().unwrap();
        let document = file_path(&dir, "doc.md");
        fs::write(&document, "").unwrap();
        let relative = import_image(&document, None, Some("iVBORw=="), Some(r#"../..\bad<>:"/|?*name.png. "#)).unwrap();
        assert_eq!(relative, "doc.assets/badname.png");
        assert!(dir.path().join("doc.assets/badname.png").is_file());
    }

    #[test]
    fn image_destination_rejects_paths_outside_assets() {
        let dir = tempfile::tempdir().unwrap();
        let assets = dir.path().join("doc.assets");
        for name in ["../outside.png", "..\\outside.png", "/outside.png", "sub/image.png", "..", ".", ""] {
            assert!(image_destination(&assets, name).is_err(), "accepted {name}");
        }
        assert!(image_destination(&assets, "图片 空格.png").is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn image_import_rejects_assets_junction_outside_document_directory() {
        use std::os::windows::process::CommandExt;
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let document = file_path(&dir, "doc.md");
        fs::write(&document, "").unwrap();
        let assets = dir.path().join("doc.assets");
        let created = std::process::Command::new("cmd.exe")
            .args(["/C", "mklink", "/J"])
            .arg(&assets).arg(outside.path()).creation_flags(0x08000000).output().unwrap();
        assert!(created.status.success(), "junction setup failed: {:?}", created);
        let result = import_image(&document, None, Some("iVBORw=="), Some("image.png"));
        // Remove only the junction itself before TempDir cleanup.
        fs::remove_dir(&assets).unwrap();
        assert!(result.is_err());
        assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
    }

    #[test]
    fn image_import_rejects_invalid_sources_before_creating_assets() {
        let dir = tempfile::tempdir().unwrap();
        let document = file_path(&dir, "doc.md");
        fs::write(&document, "").unwrap();
        assert!(import_image("", None, Some("iVBORw=="), Some("image.png")).is_err());
        assert!(import_image(&document, None, None, None).is_err());
        assert!(import_image(&document, Some(&document), Some("iVBORw=="), Some("image.png")).is_err());
        assert!(import_image(&document, None, Some("invalid base64!"), Some("image.png")).is_err());
        assert!(import_image(&document, None, Some("iVBORw=="), Some("file.exe")).is_err());
        assert!(!dir.path().join("doc.assets").exists());
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
