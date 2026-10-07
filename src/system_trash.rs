//! Единственное место, которое знает о корзинах системы — как они устроены и как в них переносит
//! крейт `trash`: остальной код видит только `is_trash_folder` и `TrashOutcome`.

use std::ffi::OsStr;
use std::io;
use std::path::Path;

use crate::cleanup::{TrashFailure, TrashOutcome};

const FREEDESKTOP_HOME_TRASH: &str = "Trash";
const FREEDESKTOP_TRASH_SUBFOLDERS: [&str; 2] = ["files", "info"];
const FREEDESKTOP_VOLUME_TRASH: &str = ".Trash";
const FREEDESKTOP_USER_TRASH_PREFIX: &str = ".Trash-";
const MACOS_VOLUME_TRASH: &str = ".Trashes";
const WINDOWS_TRASH: &str = "$RECYCLE.BIN";

/// Папка корзины системы: файлы в ней уже выброшены, и искать среди них дубликаты нельзя —
/// оставляемой копией могла бы стать та, что лежит в корзине.
///
/// Корзина узнаётся по устройству, а не по `HOME` и `XDG_DATA_HOME`: окружение называет только
/// корзину текущего пользователя и только по одному пути, а под `sudo` или через bind mount
/// в проверяемой папке окажется чужая корзина или своя по другому пути. Ошибается правило
/// в безопасную сторону: папку, похожую на корзину, не проверим, но настоящий файл не выбросим.
pub fn is_trash_folder(folder: &Path) -> bool {
    has_volume_trash_name(folder) || is_freedesktop_home_trash(folder)
}

/// Домашняя корзина freedesktop — `Trash` с подпапками `files` и `info`. Имя сравнивается
/// с учётом регистра, как в стандарте: папка `trash` — обычная папка пользователя.
fn is_freedesktop_home_trash(folder: &Path) -> bool {
    let is_named_trash = folder
        .file_name()
        .is_some_and(|name| name == FREEDESKTOP_HOME_TRASH);
    if !is_named_trash {
        return false;
    }

    FREEDESKTOP_TRASH_SUBFOLDERS
        .iter()
        .any(|subfolder| folder.join(subfolder).is_dir())
}

fn has_volume_trash_name(folder: &Path) -> bool {
    let Some(name) = folder.file_name().and_then(OsStr::to_str) else {
        return false;
    };

    let is_user_trash_of_volume = name
        .strip_prefix(FREEDESKTOP_USER_TRASH_PREFIX)
        .is_some_and(is_user_number);

    is_user_trash_of_volume
        || name == FREEDESKTOP_VOLUME_TRASH
        || name == MACOS_VOLUME_TRASH
        || name.eq_ignore_ascii_case(WINDOWS_TRASH)
}

fn is_user_number(text: &str) -> bool {
    !text.is_empty() && text.chars().all(|character| character.is_ascii_digit())
}

/// Переносит файл в корзину системы: навсегда ничего не удаляется.
pub fn move_to_system_trash(path: &Path) -> TrashOutcome {
    trash::delete(path).map_err(|error| failure_of(&error))
}

fn failure_of(error: &trash::Error) -> TrashFailure {
    match io_error_of(error) {
        Some(io_error) if io_error.kind() == io::ErrorKind::NotFound => TrashFailure::Vanished,
        Some(io_error) if io_error.kind() == io::ErrorKind::PermissionDenied => {
            TrashFailure::AccessDenied
        }
        _ => TrashFailure::Unexpected(error.to_string()),
    }
}

// Ошибка файловой системы есть в крейте только для корзины по стандарту freedesktop.
#[cfg(all(
    unix,
    not(target_os = "macos"),
    not(target_os = "ios"),
    not(target_os = "android")
))]
fn io_error_of(error: &trash::Error) -> Option<&io::Error> {
    match error {
        trash::Error::FileSystem { source, .. } => Some(source),
        _ => None,
    }
}

#[cfg(not(all(
    unix,
    not(target_os = "macos"),
    not(target_os = "ios"),
    not(target_os = "android")
)))]
fn io_error_of(_error: &trash::Error) -> Option<&io::Error> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    use std::fs;
    use std::path::PathBuf;

    fn make_folder(path: &Path) -> PathBuf {
        fs::create_dir_all(path).unwrap();
        path.to_path_buf()
    }

    #[test]
    fn volume_and_other_system_trash_names_are_recognised() {
        for name in [
            ".Trash",
            ".Trash-1000",
            ".Trash-0",
            ".Trashes",
            "$RECYCLE.BIN",
            "$Recycle.Bin",
            "$recycle.bin",
        ] {
            assert!(
                is_trash_folder(Path::new("/mnt/disk").join(name).as_path()),
                "{name}"
            );
        }
    }

    #[test]
    fn similar_looking_names_are_not_trash() {
        for name in [
            ".trash",
            ".Trash-",
            ".Trash-abc",
            ".Trash-1000x",
            ".Trash-10-00",
            ".Trashes2",
            "RECYCLE.BIN",
            "Photos",
        ] {
            assert!(
                !is_trash_folder(Path::new("/mnt/disk").join(name).as_path()),
                "{name}"
            );
        }
    }

    #[test]
    fn folder_without_a_name_is_not_trash() {
        assert!(!is_trash_folder(Path::new("/")));
        assert!(!is_trash_folder(Path::new("..")));
    }

    #[test]
    fn trash_with_files_or_info_inside_is_home_trash() {
        let root = TempDir::new().unwrap();

        for subfolder in ["files", "info"] {
            let trash = root.path().join(subfolder).join("Trash");
            make_folder(&trash.join(subfolder));

            assert!(is_trash_folder(&trash), "{subfolder}");
        }
    }

    #[test]
    fn home_trash_is_recognised_wherever_it_lies() {
        let root = TempDir::new().unwrap();
        let trash = root.path().join("anna/.local/share/Trash");
        make_folder(&trash.join("files"));

        assert!(is_trash_folder(&trash));
        assert!(!is_trash_folder(&trash.join("files")));
        assert!(!is_trash_folder(&root.path().join("anna")));
    }

    #[test]
    fn trash_without_files_and_info_is_an_ordinary_folder() {
        let root = TempDir::new().unwrap();
        let trash = make_folder(&root.path().join("Trash"));
        make_folder(&trash.join("photos"));

        assert!(!is_trash_folder(&trash));
    }

    #[test]
    fn trash_with_files_as_a_file_is_an_ordinary_folder() {
        let root = TempDir::new().unwrap();
        let trash = make_folder(&root.path().join("Trash"));
        fs::write(trash.join("files"), "обычный файл").unwrap();

        assert!(!is_trash_folder(&trash));
    }

    #[test]
    fn missing_trash_folder_is_not_trash() {
        let root = TempDir::new().unwrap();

        assert!(!is_trash_folder(&root.path().join("Trash")));
    }

    #[test]
    fn trash_name_in_other_case_is_an_ordinary_folder() {
        let root = TempDir::new().unwrap();

        for name in ["trash", "TRASH"] {
            let folder = root.path().join(name);
            make_folder(&folder.join("files"));

            assert!(!is_trash_folder(&folder), "{name}");
        }
    }

    #[test]
    fn error_without_file_system_cause_keeps_system_message() {
        let error = trash::Error::Unknown {
            description: "сбой".to_string(),
        };

        assert_eq!(
            failure_of(&error),
            TrashFailure::Unexpected(error.to_string())
        );
    }

    #[cfg(all(
        unix,
        not(target_os = "macos"),
        not(target_os = "ios"),
        not(target_os = "android")
    ))]
    mod file_system_errors {
        use super::*;

        fn file_system_error(kind: io::ErrorKind) -> trash::Error {
            trash::Error::FileSystem {
                path: "/x".into(),
                source: io::Error::from(kind),
            }
        }

        #[test]
        fn missing_file_means_vanished() {
            let error = file_system_error(io::ErrorKind::NotFound);

            assert_eq!(failure_of(&error), TrashFailure::Vanished);
        }

        #[test]
        fn denied_access_means_access_denied() {
            let error = file_system_error(io::ErrorKind::PermissionDenied);

            assert_eq!(failure_of(&error), TrashFailure::AccessDenied);
        }

        #[test]
        fn other_file_system_error_keeps_system_message() {
            let error = file_system_error(io::ErrorKind::NotADirectory);

            assert_eq!(
                failure_of(&error),
                TrashFailure::Unexpected(error.to_string())
            );
        }
    }
}
