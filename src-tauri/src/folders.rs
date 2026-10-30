use serde::Serialize;
use std::{fs, path::Path};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderEntry {
    pub name: String,
    pub path: String,
    pub is_directory: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderListing {
    pub root: String,
    pub path: String,
    pub entries: Vec<FolderEntry>,
}

// Match document paths: do not expose Windows canonicalization's verbatim prefix to the UI.
fn display_path(path: &Path) -> String {
    let value = path.to_string_lossy();
    if let Some(unc) = value.strip_prefix("\\\\?\\UNC\\") {
        format!("\\\\{unc}")
    } else {
        value.strip_prefix("\\\\?\\").unwrap_or(&value).to_string()
    }
}

fn is_link(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // Junctions and other reparse points must not expand outside the selected tree.
        return metadata.file_attributes() & 0x400 != 0;
    }
    #[cfg(not(windows))]
    false
}

fn is_markdown(path: &Path) -> bool {
    path.extension().and_then(|extension| extension.to_str()).is_some_and(|extension| {
        matches!(extension.to_ascii_lowercase().as_str(), "md" | "markdown" | "mdown" | "mkd")
    })
}

/// List one directory at a time. File contents are never read by the sidebar.
pub fn list_document_folder(root: &str, path: Option<&str>) -> Result<FolderListing, String> {
    let root = fs::canonicalize(root).map_err(|e| format!("无法打开文件夹：{e}"))?;
    if !root.is_dir() {
        return Err("所选路径不是文件夹。".into());
    }
    let requested = path.map(Path::new).unwrap_or(&root);
    let requested = if requested.is_absolute() { requested.to_path_buf() } else { root.join(requested) };
    let directory = fs::canonicalize(&requested).map_err(|e| format!("无法读取文件夹：{e}"))?;
    if !directory.starts_with(&root) {
        return Err("只能浏览所选文件夹中的内容。".into());
    }
    if !directory.is_dir() {
        return Err("所选路径不是文件夹。".into());
    }
    if requested != root && is_link(&fs::symlink_metadata(&requested).map_err(|e| format!("无法读取文件夹：{e}"))?) {
        return Err("不展开链接文件夹，请直接选择目标文件夹。".into());
    }

    let mut entries = Vec::new();
    for entry in fs::read_dir(&directory).map_err(|e| format!("无法读取文件夹：{e}"))? {
        let entry = entry.map_err(|e| format!("无法读取文件夹条目：{e}"))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let metadata = fs::symlink_metadata(entry.path()).map_err(|e| format!("无法读取文件夹条目：{e}"))?;
        if is_link(&metadata) {
            continue;
        }
        let is_directory = metadata.is_dir();
        if is_directory {
            let lower_name = name.to_ascii_lowercase();
            if lower_name == "node_modules" || lower_name.ends_with(".assets") {
                continue;
            }
        } else if !metadata.is_file() || !is_markdown(&entry.path()) {
            continue;
        }
        entries.push(FolderEntry { name, path: display_path(&entry.path()), is_directory });
    }
    entries.sort_by(|a, b| {
        b.is_directory.cmp(&a.is_directory)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(FolderListing { root: display_path(&root), path: display_path(&directory), entries })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_chinese_and_spaces_with_usable_paths() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("中文 笔记");
        fs::create_dir(&root).unwrap();
        let document = root.join("第一篇 笔记.md");
        fs::write(&document, "# 你好").unwrap();
        let listing = list_document_folder(root.to_str().unwrap(), None).unwrap();
        assert_eq!(listing.entries.len(), 1);
        assert_eq!(listing.entries[0].name, "第一篇 笔记.md");
        assert!(!listing.entries[0].is_directory);
        assert_eq!(fs::read_to_string(&listing.entries[0].path).unwrap(), "# 你好");
        assert_eq!(fs::canonicalize(&listing.path).unwrap(), fs::canonicalize(&root).unwrap());
        assert!(!listing.path.starts_with("\\\\?\\"));
    }

    #[test]
    fn filters_non_documents_and_sorts_folders_first() {
        let temp = tempfile::tempdir().unwrap();
        for name in ["Z folder", "a folder", ".git", "node_modules", "日记.assets"] {
            fs::create_dir(temp.path().join(name)).unwrap();
        }
        for name in ["B.md", "a.MD", "c.markdown", "d.mdown", "e.mkd", "notes.txt", "photo.png", ".hidden.md"] {
            fs::write(temp.path().join(name), "").unwrap();
        }
        let listing = list_document_folder(temp.path().to_str().unwrap(), None).unwrap();
        let names: Vec<_> = listing.entries.iter().map(|entry| entry.name.as_str()).collect();
        assert_eq!(names, ["a folder", "Z folder", "a.MD", "B.md", "c.markdown", "d.mdown", "e.mkd"]);
        assert!(listing.entries[..2].iter().all(|entry| entry.is_directory));
        assert!(listing.entries[2..].iter().all(|entry| !entry.is_directory));
    }

    #[test]
    fn reads_only_requested_level_and_keeps_root() {
        let temp = tempfile::tempdir().unwrap();
        let nested = temp.path().join("章节");
        fs::create_dir(&nested).unwrap();
        fs::write(nested.join("正文.md"), "").unwrap();
        let initial = list_document_folder(temp.path().to_str().unwrap(), None).unwrap();
        assert_eq!(initial.entries.len(), 1);
        assert_eq!(initial.entries[0].name, "章节");
        let child = list_document_folder(&initial.root, Some(&initial.entries[0].path)).unwrap();
        assert_eq!(child.root, initial.root);
        assert_eq!(child.path, initial.entries[0].path);
        assert_eq!(child.entries.len(), 1);
        assert_eq!(child.entries[0].name, "正文.md");
    }

    #[test]
    fn rejects_paths_outside_root_and_files_as_directories() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("notes");
        let outside = temp.path().join("notes-other");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&outside).unwrap();
        let document = root.join("正文.md");
        fs::write(&document, "").unwrap();
        let root_str = root.to_str().unwrap();
        assert!(list_document_folder(root_str, Some("..")).is_err());
        assert!(list_document_folder(root_str, outside.to_str()).is_err());
        assert!(list_document_folder(root_str, document.to_str()).is_err());
        assert!(list_document_folder(document.to_str().unwrap(), None).is_err());
        assert!(list_document_folder(root_str, Some("missing")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn skips_symlinks_and_rejects_symlink_escape() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        symlink(outside.path(), root.path().join("linked")).unwrap();
        let listing = list_document_folder(root.path().to_str().unwrap(), None).unwrap();
        assert!(listing.entries.is_empty());
        assert!(list_document_folder(&listing.root, Some("linked")).is_err());
    }
}