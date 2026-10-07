use std::fs;
use std::path::{Path, PathBuf};

use assert_cmd::cargo::cargo_bin_cmd;
use predicates::prelude::*;
use tempfile::TempDir;

fn write_file(folder: &Path, relative_path: &str, content: &str) {
    let path = folder.join(relative_path);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, content).unwrap();
}

fn run_dupes(folder: &Path) -> assert_cmd::assert::Assert {
    cargo_bin_cmd!("dupes").arg(folder).assert()
}

#[test]
fn finds_duplicates_in_subfolder_with_cyrillic_name() {
    let folder = TempDir::new().unwrap();
    write_file(folder.path(), "документ.txt", "одинаковое содержимое");
    write_file(
        folder.path(),
        "копии/документ копия.txt",
        "одинаковое содержимое",
    );

    run_dupes(folder.path())
        .success()
        .stdout(predicate::str::contains(
            "Найдено групп одинаковых файлов: 1.",
        ))
        .stdout(predicate::str::contains("документ.txt"))
        .stdout(predicate::str::contains("копии/документ копия.txt"))
        .stdout(predicate::str::contains("освободится"))
        .stderr(predicate::str::is_empty());
}

#[test]
fn reports_when_there_are_no_duplicates() {
    let folder = TempDir::new().unwrap();
    write_file(folder.path(), "a.txt", "один");
    write_file(folder.path(), "b.txt", "второй, подлиннее");

    run_dupes(folder.path())
        .success()
        .stdout("Одинаковых файлов не найдено.\n")
        .stderr(predicate::str::is_empty());
}

#[test]
fn same_size_with_different_content_is_not_a_duplicate() {
    let folder = TempDir::new().unwrap();
    write_file(folder.path(), "a.txt", "aaaa");
    write_file(folder.path(), "b.txt", "bbbb");

    run_dupes(folder.path())
        .success()
        .stdout("Одинаковых файлов не найдено.\n");
}

#[test]
fn empty_files_are_not_duplicates() {
    let folder = TempDir::new().unwrap();
    write_file(folder.path(), "a.txt", "");
    write_file(folder.path(), "b.txt", "");

    run_dupes(folder.path())
        .success()
        .stdout("Одинаковых файлов не найдено.\n");
}

#[cfg(unix)]
#[test]
fn symlink_is_not_counted_as_duplicate() {
    let folder = TempDir::new().unwrap();
    write_file(folder.path(), "real.txt", "содержимое");
    std::os::unix::fs::symlink(
        folder.path().join("real.txt"),
        folder.path().join("link.txt"),
    )
    .unwrap();

    run_dupes(folder.path())
        .success()
        .stdout("Одинаковых файлов не найдено.\n")
        .stderr(predicate::str::is_empty());
}

#[test]
fn groups_are_ordered_by_reclaimable_space_and_output_is_stable() {
    let folder = TempDir::new().unwrap();
    write_file(folder.path(), "a_small_1.txt", "0123456789");
    write_file(folder.path(), "a_small_2.txt", "0123456789");
    write_file(folder.path(), "z_big_1.txt", &"x".repeat(1000));
    write_file(folder.path(), "z_big_2.txt", &"x".repeat(1000));

    let first_run = run_dupes(folder.path())
        .success()
        .get_output()
        .stdout
        .clone();
    let second_run = run_dupes(folder.path())
        .success()
        .get_output()
        .stdout
        .clone();

    let output = String::from_utf8(first_run.clone()).unwrap();
    let big_position = output.find("z_big_1.txt").unwrap();
    let small_position = output.find("a_small_1.txt").unwrap();
    assert!(big_position < small_position, "{output}");
    assert_eq!(first_run, second_run);
}

#[test]
fn empty_folder_has_no_duplicates() {
    let folder = TempDir::new().unwrap();

    run_dupes(folder.path())
        .success()
        .stdout("Одинаковых файлов не найдено.\n")
        .stderr(predicate::str::is_empty());
}

#[test]
fn single_file_has_no_duplicates() {
    let folder = TempDir::new().unwrap();
    write_file(folder.path(), "a.txt", "единственный");

    run_dupes(folder.path())
        .success()
        .stdout("Одинаковых файлов не найдено.\n");
}

#[test]
fn three_identical_files_free_space_of_all_but_one() {
    let folder = TempDir::new().unwrap();
    let content = "x".repeat(1024);
    write_file(folder.path(), "a.txt", &content);
    write_file(folder.path(), "b.txt", &content);
    write_file(folder.path(), "sub/c.txt", &content);

    run_dupes(folder.path())
        .success()
        .stdout(predicate::str::contains("файлов — 3"))
        .stdout(predicate::str::contains("c.txt"))
        .stdout(predicate::str::contains("освободится 2,0 КБ."));
}

#[test]
fn several_groups_sum_up_reclaimable_space() {
    let folder = TempDir::new().unwrap();
    let large = "y".repeat(2048);
    write_file(folder.path(), "l1.txt", &large);
    write_file(folder.path(), "l2.txt", &large);
    write_file(folder.path(), "s1.txt", &"z".repeat(1024));
    write_file(folder.path(), "s2.txt", &"z".repeat(1024));
    write_file(folder.path(), "s3.txt", &"z".repeat(1024));

    run_dupes(folder.path())
        .success()
        .stdout(predicate::str::contains(
            "Найдено групп одинаковых файлов: 2.",
        ))
        .stdout(predicate::str::contains("освободится 4,0 КБ."));
}

#[test]
fn missing_folder_is_explained_with_exit_code_1() {
    let folder = TempDir::new().unwrap();

    run_dupes(&folder.path().join("нет такой"))
        .code(1)
        .stdout(predicate::str::is_empty())
        .stderr(predicate::str::contains("не найдена"));
}

#[test]
fn path_through_a_file_is_explained_in_russian_with_exit_code_1() {
    let folder = TempDir::new().unwrap();
    write_file(folder.path(), "a.txt", "содержимое");

    run_dupes(&folder.path().join("a.txt").join("sub"))
        .code(1)
        .stdout(predicate::str::is_empty())
        .stderr(predicate::str::contains("одна из частей этого пути"))
        .stderr(predicate::str::contains("это файл, а не папка").not())
        .stderr(predicate::str::contains("os error").not());
}

#[test]
fn file_instead_of_folder_is_explained_with_exit_code_1() {
    let folder = TempDir::new().unwrap();
    write_file(folder.path(), "a.txt", "содержимое");

    run_dupes(&folder.path().join("a.txt"))
        .code(1)
        .stdout(predicate::str::is_empty())
        .stderr(predicate::str::contains("это файл, а не папка"));
}

#[test]
fn missing_argument_is_explained_with_exit_code_2() {
    cargo_bin_cmd!("dupes")
        .assert()
        .code(2)
        .stdout(predicate::str::is_empty())
        .stderr(predicate::str::contains(
            "Укажите папку, в которой искать одинаковые файлы или похожие фото",
        ))
        .stderr(predicate::str::contains("Справка: dupes --help"));
}

#[test]
fn help_is_fully_in_russian() {
    let assert = cargo_bin_cmd!("dupes")
        .arg("--help")
        .assert()
        .success()
        .stdout(predicate::str::contains(
            "Использование: dupes [ПАРАМЕТРЫ] <ПАПКА>",
        ))
        .stdout(predicate::str::contains("ПАПКА"))
        .stdout(predicate::str::contains("Показать эту справку"))
        .stdout(predicate::str::contains("--similar"))
        .stdout(predicate::str::contains("--similarity"))
        .stdout(predicate::str::contains("ПРОЦЕНТ"))
        .stdout(predicate::str::contains("По умолчанию — 90"));

    let help = String::from_utf8(assert.get_output().stdout.clone())
        .unwrap()
        .to_lowercase();
    for english_word in [
        "usage",
        "arguments",
        "options",
        "option",
        "print help",
        "default",
    ] {
        assert!(
            !help.contains(english_word),
            "«{english_word}» в справке:\n{help}"
        );
    }
}

#[cfg(unix)]
mod permissions {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    const NO_ACCESS: u32 = 0o000;
    const FULL_ACCESS: u32 = 0o755;

    /// Возвращает права на место при выходе из теста, иначе `TempDir` не сможет удалить каталог.
    struct RestoredPermissions {
        path: PathBuf,
    }

    impl Drop for RestoredPermissions {
        fn drop(&mut self) {
            let _ = fs::set_permissions(&self.path, fs::Permissions::from_mode(FULL_ACCESS));
        }
    }

    fn deny_access(path: &Path) -> RestoredPermissions {
        fs::set_permissions(path, fs::Permissions::from_mode(NO_ACCESS)).unwrap();
        RestoredPermissions {
            path: path.to_path_buf(),
        }
    }

    /// Под root права не действуют: проверяем это на пробном файле в отдельном каталоге,
    /// чтобы он не попал в проверяемую папку.
    fn permissions_are_enforced() -> bool {
        let probe_folder = TempDir::new().unwrap();
        let probe = probe_folder.path().join("probe.txt");
        fs::write(&probe, "probe").unwrap();
        let _restore = deny_access(&probe);

        let is_enforced = fs::read(&probe).is_err();
        if !is_enforced {
            eprintln!("пропущено: права доступа не действуют — тест запущен от root");
        }
        is_enforced
    }

    #[test]
    fn unreadable_file_is_warned_about_and_other_duplicates_are_found() {
        let folder = TempDir::new().unwrap();
        if !permissions_are_enforced() {
            return;
        }
        write_file(folder.path(), "a.txt", "четыре");
        write_file(folder.path(), "b.txt", "четыре");
        write_file(folder.path(), "secret.txt", "четыре");
        let _restore = deny_access(&folder.path().join("secret.txt"));

        run_dupes(folder.path())
            .success()
            .stdout(predicate::str::contains(
                "Найдено групп одинаковых файлов: 1.",
            ))
            .stdout(predicate::str::contains("a.txt"))
            .stderr(predicate::str::contains("Не удалось прочитать"))
            .stderr(predicate::str::contains("secret.txt"))
            .stderr(predicate::str::contains("нет прав на чтение"));
    }

    #[test]
    fn unreadable_subfolder_is_warned_about_and_other_duplicates_are_found() {
        let folder = TempDir::new().unwrap();
        if !permissions_are_enforced() {
            return;
        }
        write_file(folder.path(), "a.txt", "содержимое");
        write_file(folder.path(), "b.txt", "содержимое");
        write_file(folder.path(), "closed/c.txt", "содержимое");
        let _restore = deny_access(&folder.path().join("closed"));

        run_dupes(folder.path())
            .success()
            .stdout(predicate::str::contains(
                "Найдено групп одинаковых файлов: 1.",
            ))
            .stderr(predicate::str::contains("Не удалось прочитать"))
            .stderr(predicate::str::contains("closed"))
            .stderr(predicate::str::contains("нет прав на чтение"));
    }

    #[test]
    fn unreadable_root_folder_is_explained_with_exit_code_1() {
        let folder = TempDir::new().unwrap();
        if !permissions_are_enforced() {
            return;
        }
        write_file(folder.path(), "closed/a.txt", "содержимое");
        let _restore = deny_access(&folder.path().join("closed"));

        run_dupes(&folder.path().join("closed"))
            .code(1)
            .stdout(predicate::str::is_empty())
            .stderr(predicate::str::contains("Нет доступа к папке"));
    }
}
