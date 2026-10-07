use std::fs;
use std::path::{Path, PathBuf};

use assert_cmd::cargo::cargo_bin_cmd;
use predicates::prelude::*;
use serde_json::{Value, json};
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

#[cfg(unix)]
#[test]
fn hard_link_is_not_shown_as_a_duplicate() {
    let folder = TempDir::new().unwrap();
    write_file(folder.path(), "a.txt", "содержимое");
    fs::hard_link(folder.path().join("a.txt"), folder.path().join("b.txt")).unwrap();

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
        .stdout(predicate::str::contains("По умолчанию — 90"))
        .stdout(predicate::str::contains("--trash"))
        .stdout(predicate::str::contains("пока не добавлен --yes"))
        .stdout(predicate::str::contains("--yes"))
        .stdout(predicate::str::contains("можно вернуть из корзины"))
        .stdout(predicate::str::contains("--json"))
        .stdout(predicate::str::contains("формате JSON"))
        .stdout(predicate::str::contains("--version"))
        .stdout(predicate::str::contains("Показать версию программы"));

    let help = String::from_utf8(assert.get_output().stdout.clone())
        .unwrap()
        .to_lowercase();
    for english_word in [
        "usage",
        "arguments",
        "options",
        "option",
        "print help",
        "print version",
        "default",
    ] {
        assert!(
            !help.contains(english_word),
            "«{english_word}» в справке:\n{help}"
        );
    }
}

#[test]
fn report_without_trash_flag_does_not_touch_files_and_hints_at_trash() {
    let folder = TempDir::new().unwrap();
    write_file(folder.path(), "a.txt", "содержимое");
    write_file(folder.path(), "b.txt", "содержимое");

    run_dupes(folder.path())
        .success()
        .stdout(predicate::str::contains("(самый старый)"))
        .stdout(predicate::str::contains(
            "Если оставить в каждой группе только самый старый файл, освободится",
        ))
        .stdout(predicate::str::contains(
            "повторите команду, добавив --trash",
        ))
        .stdout(predicate::str::contains("остаётся:").not());

    assert!(folder.path().join("a.txt").exists());
    assert!(folder.path().join("b.txt").exists());
}

fn json_report_of(folder: &Path, extra_arguments: &[&str]) -> Value {
    let assert = cargo_bin_cmd!("dupes")
        .arg("--json")
        .args(extra_arguments)
        .arg(folder)
        .assert()
        .success()
        .stderr(predicate::str::is_empty());

    serde_json::from_slice(&assert.get_output().stdout).unwrap()
}

#[test]
fn json_report_describes_groups_with_all_keys() {
    let folder = TempDir::new().unwrap();
    write_file(folder.path(), "a.txt", "содержимое");
    write_file(folder.path(), "sub/b.txt", "содержимое");
    let size = "содержимое".len();

    let report = json_report_of(folder.path(), &[]);

    let keep = &report["groups"][0]["keep"];
    let extra = &report["groups"][0]["extras"][0];
    assert_eq!(report["mode"], "duplicates");
    assert_eq!(report["similarity_percent"], Value::Null);
    assert_eq!(report["action"], "report");
    assert_eq!(report["reclaimable_bytes"], size);
    assert_eq!(report["trashed_count"], Value::Null);
    assert_eq!(report["trashed_bytes"], Value::Null);
    assert_eq!(report["failed_count"], Value::Null);
    assert_eq!(report["skipped"], json!([]));
    assert_eq!(keep["size"], size);
    assert_eq!(keep["width"], Value::Null);
    assert_eq!(keep["height"], Value::Null);
    assert_eq!(extra["status"], Value::Null);
    assert_eq!(extra["error"], Value::Null);
    let all_paths = [
        keep["path"].as_str().unwrap(),
        extra["path"].as_str().unwrap(),
    ];
    assert!(all_paths.iter().any(|path| path.ends_with("a.txt")));
    assert!(all_paths.iter().any(|path| path.ends_with("b.txt")));
}

#[test]
fn json_dry_run_and_similar_mode_are_named_in_the_report() {
    let folder = TempDir::new().unwrap();

    let dry_run = json_report_of(folder.path(), &["--trash"]);
    let similar = json_report_of(folder.path(), &["--similar", "--similarity", "75"]);

    assert_eq!(dry_run["action"], "dry_run");
    assert_eq!(dry_run["groups"], json!([]));
    assert_eq!(similar["mode"], "similar_photos");
    assert_eq!(similar["similarity_percent"], 75);
    assert_eq!(similar["action"], "report");
}

#[test]
fn json_is_printed_even_when_nothing_is_found() {
    let folder = TempDir::new().unwrap();

    let report = json_report_of(folder.path(), &[]);

    assert_eq!(report["groups"], json!([]));
    assert_eq!(report["reclaimable_bytes"], 0);
}

#[test]
fn json_keeps_warnings_out_of_stderr() {
    let folder = TempDir::new().unwrap();
    write_file(folder.path(), "broken.png", "это не картинка");

    let report = json_report_of(folder.path(), &["--similar"]);

    let skipped = &report["skipped"][0];
    assert!(skipped["path"].as_str().unwrap().ends_with("broken.png"));
    assert_eq!(skipped["reason"], "damaged_image");
    assert_eq!(skipped["message"], "файл повреждён или это не изображение");
}

#[test]
fn folder_error_with_json_prints_only_the_russian_message_to_stderr() {
    let folder = TempDir::new().unwrap();

    cargo_bin_cmd!("dupes")
        .arg("--json")
        .arg(folder.path().join("нет такой"))
        .assert()
        .code(1)
        .stdout(predicate::str::is_empty())
        .stderr(predicate::str::contains("не найдена"));
}

#[test]
fn version_is_printed_by_both_flags() {
    let expected = format!("dupes {}\n", env!("CARGO_PKG_VERSION"));

    for flag in ["--version", "-V"] {
        cargo_bin_cmd!("dupes")
            .arg(flag)
            .assert()
            .success()
            .stdout(expected.clone())
            .stderr(predicate::str::is_empty());
    }
}

#[test]
fn yes_without_trash_is_explained_with_exit_code_2() {
    let folder = TempDir::new().unwrap();
    write_file(folder.path(), "a.txt", "содержимое");
    write_file(folder.path(), "b.txt", "содержимое");

    cargo_bin_cmd!("dupes")
        .arg("--yes")
        .arg(folder.path())
        .assert()
        .code(2)
        .stdout(predicate::str::is_empty())
        .stderr(
            "--yes подтверждает перенос в корзину — добавьте --trash. \
             Например: dupes --trash --yes ~/Загрузки\n\
             Справка: dupes --help\n",
        );

    assert!(folder.path().join("a.txt").exists());
    assert!(folder.path().join("b.txt").exists());
}

#[test]
fn repeated_flags_are_explained_with_exit_code_2() {
    let folder = TempDir::new().unwrap();

    for flag in ["--trash", "--yes", "--json", "--similar"] {
        cargo_bin_cmd!("dupes")
            .args(["--similar", "--trash", flag, flag])
            .arg(folder.path())
            .assert()
            .code(2)
            .stdout(predicate::str::is_empty())
            .stderr(format!(
                "Параметр {flag} указан несколько раз — укажите его один раз.\n\
                 Справка: dupes --help\n"
            ));
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

    #[test]
    fn unreadable_file_with_json_is_listed_in_skipped_and_stderr_stays_empty() {
        let folder = TempDir::new().unwrap();
        if !permissions_are_enforced() {
            return;
        }
        write_file(folder.path(), "a.txt", "четыре");
        write_file(folder.path(), "b.txt", "четыре");
        write_file(folder.path(), "secret.txt", "четыре");
        let _restore = deny_access(&folder.path().join("secret.txt"));

        let report = json_report_of(folder.path(), &[]);

        let skipped = &report["skipped"][0];
        assert!(skipped["path"].as_str().unwrap().ends_with("secret.txt"));
        assert_eq!(skipped["reason"], "access_denied");
        assert_eq!(skipped["message"], "нет прав на чтение");
        assert_eq!(report["groups"].as_array().unwrap().len(), 1);
    }
}
