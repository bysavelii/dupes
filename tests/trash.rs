//! Перенос в корзину проверяется только дочерним процессом `dupes`, которому `XDG_DATA_HOME`
//! и `HOME` подменены на каталоги внутри того же `TempDir`, где лежит проверяемая папка:
//! настоящая корзина пользователя не затрагивается. На macOS и Windows крейт `trash`
//! пишет в системную корзину, поэтому тесты идут только под Linux.
#![cfg(target_os = "linux")]

use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use assert_cmd::cargo::cargo_bin_cmd;
use image::RgbImage;
use predicates::prelude::*;
use serde_json::Value;
use tempfile::TempDir;

const FULL_WIDTH: u32 = 640;
const FULL_HEIGHT: u32 = 480;
const SMALL_WIDTH: u32 = 160;
const SMALL_HEIGHT: u32 = 120;
const SAME_CONTENT: &str = "одинаковое содержимое";
const FIRST_FILE_SECONDS: u64 = 1_000;

#[path = "../src/test_images.rs"]
mod test_images;

/// Проверяемая папка, «домашний» каталог и каталог данных (в нём живёт корзина) — в одном `TempDir`,
/// чтобы все они лежали на одной файловой системе.
struct Sandbox {
    root: TempDir,
}

impl Sandbox {
    fn new() -> Self {
        let root = TempDir::new().unwrap();
        for name in ["folder", "data", "home"] {
            fs::create_dir(root.path().join(name)).unwrap();
        }
        Sandbox { root }
    }

    fn folder(&self) -> PathBuf {
        self.root.path().join("folder")
    }

    fn data_home(&self) -> PathBuf {
        self.root.path().join("data")
    }

    fn trash_files(&self) -> PathBuf {
        self.data_home().join("Trash/files")
    }

    fn trash_info(&self) -> PathBuf {
        self.data_home().join("Trash/info")
    }

    fn home(&self) -> PathBuf {
        self.root.path().join("home")
    }

    fn write_file(&self, relative_path: &str, content: &str, modified_seconds: u64) {
        write_file_at(
            &self.folder().join(relative_path),
            content,
            modified_seconds,
        );
    }

    fn run(&self, arguments: &[&str]) -> assert_cmd::assert::Assert {
        self.run_on(&self.folder(), arguments)
    }

    fn run_on(&self, folder: &Path, arguments: &[&str]) -> assert_cmd::assert::Assert {
        self.run_on_with_data_home(folder, &self.data_home(), arguments)
    }

    fn run_with_data_home(
        &self,
        data_home: &Path,
        arguments: &[&str],
    ) -> assert_cmd::assert::Assert {
        self.run_on_with_data_home(&self.folder(), data_home, arguments)
    }

    fn run_on_with_data_home(
        &self,
        folder: &Path,
        data_home: &Path,
        arguments: &[&str],
    ) -> assert_cmd::assert::Assert {
        cargo_bin_cmd!("dupes")
            .env("XDG_DATA_HOME", data_home)
            .env("HOME", self.home())
            .args(arguments)
            .arg(folder)
            .assert()
    }

    /// Всё, что лежит в песочнице, с временем изменения, — чтобы сравнить «до» и «после».
    fn snapshot(&self) -> Vec<(PathBuf, SystemTime)> {
        let mut entries = Vec::new();
        collect_entries(self.root.path(), &mut entries);
        entries.sort();
        entries
    }

    fn names_in(&self, folder: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(folder)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }
}

fn write_file_at(path: &Path, content: &str, modified_seconds: u64) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, content).unwrap();
    set_modified(path, modified_seconds);
}

fn set_modified(path: &Path, seconds_after_epoch: u64) {
    let file = File::options().write(true).open(path).unwrap();
    let modified = SystemTime::UNIX_EPOCH + Duration::from_secs(seconds_after_epoch);
    file.set_modified(modified).unwrap();
}

fn collect_entries(folder: &Path, entries: &mut Vec<(PathBuf, SystemTime)>) {
    for entry in fs::read_dir(folder).unwrap() {
        let path = entry.unwrap().path();
        let modified = fs::symlink_metadata(&path).unwrap().modified().unwrap();
        entries.push((path.clone(), modified));
        if path.is_dir() {
            collect_entries(&path, entries);
        }
    }
}

fn save(image: &RgbImage, path: &Path) {
    image.save(path).unwrap();
}

#[test]
fn dry_run_shows_the_plan_and_changes_nothing() {
    let sandbox = Sandbox::new();
    sandbox.write_file("a.txt", SAME_CONTENT, 3_000);
    sandbox.write_file("b.txt", SAME_CONTENT, FIRST_FILE_SECONDS);
    sandbox.write_file("sub/c.txt", SAME_CONTENT, 2_000);
    let before = sandbox.snapshot();
    let folder = sandbox.folder();

    sandbox
        .run(&["--trash"])
        .code(0)
        .stdout(predicate::str::contains(format!(
            "остаётся: {} (самый старый)",
            folder.join("b.txt").display()
        )))
        .stdout(predicate::str::contains(format!(
            "в корзину: {}",
            folder.join("a.txt").display()
        )))
        .stdout(predicate::str::contains(format!(
            "в корзину: {}",
            folder.join("sub/c.txt").display()
        )))
        .stdout(predicate::str::contains(
            "Будет перенесено в корзину файлов — 2",
        ))
        .stdout(predicate::str::contains(
            "Это пробный запуск: файлы остались на месте.",
        ))
        .stderr(predicate::str::is_empty());

    assert_eq!(sandbox.snapshot(), before);
    assert!(!sandbox.data_home().join("Trash").exists());
}

#[test]
fn confirmed_run_keeps_the_oldest_file_and_trashes_the_rest() {
    let sandbox = Sandbox::new();
    sandbox.write_file("a.txt", SAME_CONTENT, 3_000);
    sandbox.write_file("b.txt", SAME_CONTENT, FIRST_FILE_SECONDS);
    sandbox.write_file("c.txt", SAME_CONTENT, 2_000);
    sandbox.write_file("other.txt", "другое содержимое", 4_000);
    let original_folder = fs::canonicalize(sandbox.folder()).unwrap();

    sandbox
        .run(&["--trash", "--yes"])
        .code(0)
        .stdout(predicate::str::contains("Перенесено в корзину файлов — 2"))
        .stdout(predicate::str::contains("перенесён в корзину:"))
        .stdout(predicate::str::contains("Не удалось перенести").not())
        .stderr(predicate::str::is_empty());

    assert_eq!(sandbox.names_in(&sandbox.folder()), ["b.txt", "other.txt"]);
    assert_eq!(sandbox.names_in(&sandbox.trash_files()), ["a.txt", "c.txt"]);
    for name in ["a.txt", "c.txt"] {
        let info =
            fs::read_to_string(sandbox.trash_info().join(format!("{name}.trashinfo"))).unwrap();
        let expected_path_line = format!("Path={}", original_folder.join(name).display());
        assert!(info.contains(&expected_path_line), "{info}");
    }
}

#[test]
fn equal_modification_time_keeps_the_shorter_path_then_the_first_in_alphabet() {
    let sandbox = Sandbox::new();
    sandbox.write_file("deep/inner/a.txt", SAME_CONTENT, FIRST_FILE_SECONDS);
    sandbox.write_file("c.txt", SAME_CONTENT, FIRST_FILE_SECONDS);
    sandbox.write_file("b.txt", SAME_CONTENT, FIRST_FILE_SECONDS);

    sandbox.run(&["--trash", "--yes"]).code(0);

    assert_eq!(sandbox.names_in(&sandbox.folder()), ["b.txt", "deep"]);
    assert_eq!(sandbox.names_in(&sandbox.trash_files()), ["a.txt", "c.txt"]);
}

#[test]
fn similar_photos_keep_the_best_quality_even_if_it_is_newer() {
    let sandbox = Sandbox::new();
    let folder = sandbox.folder();
    let scene = test_images::with_noise(&test_images::scene_image(FULL_WIDTH, FULL_HEIGHT));
    let small = image::imageops::resize(
        &scene,
        SMALL_WIDTH,
        SMALL_HEIGHT,
        image::imageops::FilterType::Lanczos3,
    );
    save(&scene, &folder.join("original.png"));
    save(&small, &folder.join("small.png"));
    set_modified(&folder.join("original.png"), 5_000);
    set_modified(&folder.join("small.png"), FIRST_FILE_SECONDS);

    sandbox
        .run(&["--similar", "--trash", "--yes"])
        .code(0)
        .stdout(predicate::str::contains("(лучшее качество)"))
        .stdout(predicate::str::contains("Перенесено в корзину файлов — 1"))
        .stderr(predicate::str::is_empty());

    assert_eq!(sandbox.names_in(&folder), ["original.png"]);
    assert_eq!(sandbox.names_in(&sandbox.trash_files()), ["small.png"]);
}

#[test]
fn unavailable_trash_leaves_every_file_in_place_and_exits_with_code_3() {
    let sandbox = Sandbox::new();
    sandbox.write_file("a.txt", SAME_CONTENT, FIRST_FILE_SECONDS);
    sandbox.write_file("b.txt", SAME_CONTENT, 2_000);
    sandbox.write_file("c.txt", SAME_CONTENT, 3_000);
    let not_a_folder = sandbox.root.path().join("data_is_a_file");
    fs::write(&not_a_folder, "обычный файл вместо каталога").unwrap();
    let folder = sandbox.folder();

    sandbox
        .run_with_data_home(&not_a_folder, &["--trash", "--yes"])
        .code(3)
        .stdout(predicate::str::contains(format!(
            "не перенесён: {} — непредвиденная ошибка (системное сообщение:",
            folder.join("b.txt").display()
        )))
        .stdout(predicate::str::contains(format!(
            "не перенесён: {} — непредвиденная ошибка (системное сообщение:",
            folder.join("c.txt").display()
        )))
        .stdout(predicate::str::contains(
            "Ни один файл не перенесён в корзину.",
        ))
        .stdout(predicate::str::contains("Место освободится").not())
        .stdout(predicate::str::contains(
            "Не удалось перенести файлов — 2: они остались на месте, причины указаны выше.",
        ))
        .stderr(predicate::str::is_empty());

    assert_eq!(sandbox.names_in(&folder), ["a.txt", "b.txt", "c.txt"]);
}

#[test]
fn json_report_of_a_confirmed_run_lists_statuses_and_totals() {
    let sandbox = Sandbox::new();
    sandbox.write_file("a.txt", SAME_CONTENT, 2_000);
    sandbox.write_file("b.txt", SAME_CONTENT, FIRST_FILE_SECONDS);
    let folder = sandbox.folder();

    let assert = sandbox
        .run(&["--json", "--trash", "--yes"])
        .code(0)
        .stderr(predicate::str::is_empty());

    let report: Value = serde_json::from_slice(&assert.get_output().stdout).unwrap();
    assert_eq!(report["action"], "trash");
    assert_eq!(report["trashed_count"], 1);
    assert_eq!(report["failed_count"], 0);
    assert_eq!(
        report["groups"][0]["keep"]["path"],
        folder.join("b.txt").to_string_lossy().as_ref()
    );
    assert_eq!(report["groups"][0]["extras"][0]["status"], "trashed");
    assert_eq!(report["groups"][0]["extras"][0]["error"], Value::Null);
    assert_eq!(sandbox.names_in(&sandbox.trash_files()), ["a.txt"]);
}

#[test]
fn json_report_of_a_failed_run_explains_the_error_and_exits_with_code_3() {
    let sandbox = Sandbox::new();
    sandbox.write_file("a.txt", SAME_CONTENT, FIRST_FILE_SECONDS);
    sandbox.write_file("b.txt", SAME_CONTENT, 2_000);
    let not_a_folder = sandbox.root.path().join("data_is_a_file");
    fs::write(&not_a_folder, "обычный файл вместо каталога").unwrap();

    let assert = sandbox
        .run_with_data_home(&not_a_folder, &["--json", "--trash", "--yes"])
        .code(3)
        .stderr(predicate::str::is_empty());

    let report: Value = serde_json::from_slice(&assert.get_output().stdout).unwrap();
    assert_eq!(report["trashed_count"], 0);
    assert_eq!(report["failed_count"], 1);
    let extra = &report["groups"][0]["extras"][0];
    assert_eq!(extra["status"], "failed");
    assert_eq!(extra["error"]["code"], "unexpected");
    assert!(
        extra["error"]["message"]
            .as_str()
            .unwrap()
            .starts_with("непредвиденная ошибка (системное сообщение:")
    );
}

const NOTHING_FOUND_MESSAGE: &str = "Одинаковых файлов не найдено.\n";

/// Корзина freedesktop: удалённый файл в `files`, сведения о нём — в `info`.
fn write_trashed_file(trash: &Path, name: &str, modified_seconds: u64) {
    write_file_at(
        &trash.join("files").join(name),
        SAME_CONTENT,
        modified_seconds,
    );
    write_file_at(
        &trash.join("info").join(format!("{name}.trashinfo")),
        "[Trash Info]\nPath=/old/place\nDeletionDate=2020-01-01T00:00:00\n",
        modified_seconds,
    );
}

#[test]
fn trash_of_another_home_is_not_a_reason_to_trash_the_real_file() {
    let sandbox = Sandbox::new();
    let other_home = sandbox.folder().join("home");
    write_trashed_file(
        &other_home.join(".local/share/Trash"),
        "photo.jpg",
        FIRST_FILE_SECONDS,
    );
    let real_file = other_home.join("Docs/photo.jpg");
    write_file_at(&real_file, SAME_CONTENT, 2_000);
    let before = sandbox.snapshot();

    sandbox
        .run_on(&other_home, &["--trash", "--yes"])
        .code(0)
        .stdout(NOTHING_FOUND_MESSAGE)
        .stderr(predicate::str::is_empty());

    assert_eq!(sandbox.snapshot(), before);
    assert_eq!(fs::read_to_string(real_file).unwrap(), SAME_CONTENT);
}

#[test]
fn trash_deep_inside_the_scanned_folder_is_not_checked() {
    let sandbox = Sandbox::new();
    sandbox.write_file("Docs/photo.jpg", SAME_CONTENT, 2_000);
    let other_data_home = sandbox.folder().join("backup/old-settings/data");
    write_file_at(
        &other_data_home.join("Trash/files/photo.jpg"),
        SAME_CONTENT,
        FIRST_FILE_SECONDS,
    );
    let before = sandbox.snapshot();

    sandbox
        .run(&["--trash", "--yes"])
        .code(0)
        .stdout(NOTHING_FOUND_MESSAGE)
        .stderr(predicate::str::is_empty());

    assert_eq!(sandbox.snapshot(), before);
}

#[test]
fn folder_named_trash_without_files_and_info_is_checked() {
    let sandbox = Sandbox::new();
    sandbox.write_file("Trash/photo.jpg", SAME_CONTENT, FIRST_FILE_SECONDS);
    sandbox.write_file("photo.jpg", SAME_CONTENT, 2_000);
    let folder = sandbox.folder();

    sandbox
        .run(&["--trash"])
        .code(0)
        .stdout(predicate::str::contains(format!(
            "остаётся: {} (самый старый)",
            folder.join("Trash/photo.jpg").display()
        )))
        .stdout(predicate::str::contains(format!(
            "в корзину: {}",
            folder.join("photo.jpg").display()
        )));
}

#[test]
fn volume_trash_folder_inside_the_scanned_folder_is_skipped() {
    let sandbox = Sandbox::new();
    sandbox.write_file(".Trash-1000/files/x.jpg", SAME_CONTENT, FIRST_FILE_SECONDS);
    sandbox.write_file("x.jpg", SAME_CONTENT, 2_000);
    sandbox.write_file(".Trash/files/y.jpg", SAME_CONTENT, FIRST_FILE_SECONDS);
    let before = sandbox.snapshot();

    sandbox
        .run(&["--trash", "--yes"])
        .code(0)
        .stdout(NOTHING_FOUND_MESSAGE)
        .stderr(predicate::str::is_empty());

    assert_eq!(sandbox.snapshot(), before);
}

#[test]
fn similar_photos_in_the_trash_are_not_considered() {
    let sandbox = Sandbox::new();
    let folder = sandbox.folder();
    let scene = test_images::with_noise(&test_images::scene_image(FULL_WIDTH, FULL_HEIGHT));
    fs::create_dir(folder.join(".Trash-1000")).unwrap();
    save(&scene, &folder.join(".Trash-1000/old.png"));
    save(&scene, &folder.join("new.png"));
    set_modified(&folder.join(".Trash-1000/old.png"), FIRST_FILE_SECONDS);
    set_modified(&folder.join("new.png"), 5_000);
    let before = sandbox.snapshot();

    sandbox
        .run(&["--similar", "--trash", "--yes"])
        .code(0)
        .stdout("Похожих фото не найдено.\n");

    assert_eq!(sandbox.snapshot(), before);
}

#[test]
fn trash_folder_given_as_the_scanned_folder_finds_nothing() {
    let sandbox = Sandbox::new();
    let trash = sandbox.folder().join("home/.local/share/Trash");
    write_trashed_file(&trash, "a.txt", FIRST_FILE_SECONDS);
    write_trashed_file(&trash, "b.txt", 2_000);
    let trash_files = trash.join("files");

    for folder in [&trash, &trash_files] {
        sandbox
            .run_on(folder, &[])
            .code(0)
            .stdout(NOTHING_FOUND_MESSAGE)
            .stderr(predicate::str::is_empty());
    }
}

#[test]
fn empty_folder_with_confirmation_has_nothing_to_trash() {
    let sandbox = Sandbox::new();
    let before = sandbox.snapshot();

    sandbox
        .run(&["--trash", "--yes"])
        .code(0)
        .stdout(predicate::str::contains("Одинаковых файлов не найдено."))
        .stderr(predicate::str::is_empty());

    assert_eq!(sandbox.snapshot(), before);
    assert!(!sandbox.data_home().join("Trash").exists());
}

#[test]
fn path_with_cyrillic_and_spaces_is_trashed_with_its_original_path_recorded() {
    let sandbox = Sandbox::new();
    sandbox.write_file("Мои фото/отпуск 2024.txt", SAME_CONTENT, FIRST_FILE_SECONDS);
    sandbox.write_file("Мои фото/копия отпуск.txt", SAME_CONTENT, 2_000);
    let original_folder = fs::canonicalize(sandbox.folder()).unwrap();

    sandbox
        .run(&["--trash", "--yes"])
        .code(0)
        .stdout(predicate::str::contains("Перенесено в корзину файлов — 1"))
        .stderr(predicate::str::is_empty());

    assert_eq!(
        sandbox.names_in(&sandbox.folder().join("Мои фото")),
        ["отпуск 2024.txt"]
    );
    assert_eq!(
        sandbox.names_in(&sandbox.trash_files()),
        ["копия отпуск.txt"]
    );
    let info = sandbox.names_in(&sandbox.trash_info());
    assert_eq!(info.len(), 1);
    let info_text = fs::read_to_string(sandbox.trash_info().join(&info[0])).unwrap();
    let encoded_name = "%D0%BA%D0%BE%D0%BF%D0%B8%D1%8F%20%D0%BE%D1%82%D0%BF%D1%83%D1%81%D0%BA.txt";
    let plain_path = original_folder.join("Мои фото/копия отпуск.txt");
    assert!(
        info_text.contains("Path=")
            && (info_text.contains(encoded_name)
                || info_text.contains(&plain_path.display().to_string())),
        "{info_text}"
    );
}

#[test]
fn hard_link_is_not_trashed_with_confirmation() {
    let sandbox = Sandbox::new();
    sandbox.write_file("a.txt", SAME_CONTENT, FIRST_FILE_SECONDS);
    fs::hard_link(
        sandbox.folder().join("a.txt"),
        sandbox.folder().join("link.txt"),
    )
    .unwrap();
    let before = sandbox.snapshot();

    sandbox.run(&["--trash", "--yes"]).code(0);

    assert_eq!(sandbox.snapshot(), before);
    assert!(!sandbox.trash_files().exists());
}

#[test]
fn similar_trash_json_dry_run_reports_plan_and_changes_nothing() {
    let sandbox = Sandbox::new();
    let folder = sandbox.folder();
    let scene = test_images::with_noise(&test_images::scene_image(FULL_WIDTH, FULL_HEIGHT));
    let small = image::imageops::resize(
        &scene,
        SMALL_WIDTH,
        SMALL_HEIGHT,
        image::imageops::FilterType::Lanczos3,
    );
    save(&scene, &folder.join("original.png"));
    save(&small, &folder.join("small.png"));
    let before = sandbox.snapshot();

    let assert = sandbox
        .run(&["--similar", "--trash", "--json"])
        .code(0)
        .stderr(predicate::str::is_empty());

    let report: Value = serde_json::from_slice(&assert.get_output().stdout).unwrap();
    assert_eq!(report["mode"], "similar_photos");
    assert_eq!(report["action"], "dry_run");
    assert!(report["similarity_percent"].is_number());
    assert_eq!(
        report["groups"][0]["keep"]["path"],
        folder.join("original.png").to_string_lossy().as_ref()
    );
    assert_eq!(
        report["groups"][0]["extras"][0]["path"],
        folder.join("small.png").to_string_lossy().as_ref()
    );
    assert_eq!(report["trashed_count"], Value::Null);
    assert_eq!(sandbox.snapshot(), before);
    assert!(!sandbox.data_home().join("Trash").exists());
}

#[test]
fn unreadable_file_with_json_and_trash_is_skipped_and_stderr_stays_empty() {
    use std::os::unix::fs::PermissionsExt;

    let probe = TempDir::new().unwrap();
    let probe_file = probe.path().join("probe.txt");
    fs::write(&probe_file, "probe").unwrap();
    fs::set_permissions(&probe_file, fs::Permissions::from_mode(0o000)).unwrap();
    let is_enforced = fs::read(&probe_file).is_err();
    fs::set_permissions(&probe_file, fs::Permissions::from_mode(0o644)).unwrap();
    if !is_enforced {
        eprintln!("пропущено: права доступа не действуют — тест запущен от root");
        return;
    }

    let sandbox = Sandbox::new();
    sandbox.write_file("a.txt", SAME_CONTENT, FIRST_FILE_SECONDS);
    sandbox.write_file("b.txt", SAME_CONTENT, 2_000);
    sandbox.write_file("secret.txt", SAME_CONTENT, 3_000);
    let secret = sandbox.folder().join("secret.txt");
    fs::set_permissions(&secret, fs::Permissions::from_mode(0o000)).unwrap();

    let assert = sandbox
        .run(&["--json", "--trash"])
        .code(0)
        .stderr(predicate::str::is_empty());
    fs::set_permissions(&secret, fs::Permissions::from_mode(0o644)).unwrap();

    let report: Value = serde_json::from_slice(&assert.get_output().stdout).unwrap();
    assert_eq!(report["skipped"][0]["reason"], "access_denied");
    assert!(
        report["skipped"][0]["path"]
            .as_str()
            .unwrap()
            .ends_with("secret.txt")
    );
    assert_eq!(report["groups"][0]["extras"].as_array().unwrap().len(), 1);
}
