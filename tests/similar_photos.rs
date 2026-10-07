use std::fs::{self, File};
use std::path::Path;

use assert_cmd::cargo::cargo_bin_cmd;
use image::RgbImage;
use image::codecs::jpeg::JpegEncoder;
use image::imageops::{self, FilterType};
use predicates::prelude::*;
use tempfile::TempDir;

const FULL_WIDTH: u32 = 640;
const FULL_HEIGHT: u32 = 480;
const SMALL_WIDTH: u32 = 160;
const SMALL_HEIGHT: u32 = 120;
const MEDIUM_WIDTH: u32 = 320;
const MEDIUM_HEIGHT: u32 = 240;
const LOW_JPEG_QUALITY: u8 = 30;
const GOOD_JPEG_QUALITY: u8 = 85;
const COPIES_OF_ORIGINAL: usize = 3;

#[path = "../src/test_images.rs"]
mod test_images;

fn draw(scene: RgbImage) -> RgbImage {
    test_images::with_noise(&scene)
}

fn shrunk(image: &RgbImage, width: u32, height: u32) -> RgbImage {
    imageops::resize(image, width, height, FilterType::Lanczos3)
}

fn save_jpeg(image: &RgbImage, path: &Path, quality: u8) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let file = File::create(path).unwrap();
    let mut encoder = JpegEncoder::new_with_quality(file, quality);
    encoder.encode_image(image).unwrap();
}

fn save(image: &RgbImage, path: &Path) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    image.save(path).unwrap();
}

/// Исходная картинка, её уменьшенная JPEG-копия, пересохранение в низком качестве и WebP-копия.
fn save_original_with_copies(folder: &Path) {
    let original = draw(test_images::scene_image(FULL_WIDTH, FULL_HEIGHT));
    save(&original, &folder.join("photos/original.png"));
    save_jpeg(
        &shrunk(&original, SMALL_WIDTH, SMALL_HEIGHT),
        &folder.join("photos/copy.jpg"),
        GOOD_JPEG_QUALITY,
    );
    save_jpeg(
        &original,
        &folder.join("photos/recompressed.jpg"),
        LOW_JPEG_QUALITY,
    );
    save(
        &shrunk(&original, MEDIUM_WIDTH, MEDIUM_HEIGHT),
        &folder.join("photos/copy.webp"),
    );
}

fn damaged_photo_warning(path: &Path) -> predicates::str::ContainsPredicate {
    predicate::str::contains(format!(
        "Не удалось прочитать «{}»: файл повреждён или это не изображение. Пропускаю.\n",
        path.display()
    ))
}

fn run_similar(folder: &Path) -> assert_cmd::assert::Assert {
    cargo_bin_cmd!("dupes")
        .arg("--similar")
        .arg(folder)
        .assert()
}

fn run_similar_with_threshold(folder: &Path, threshold: &str) -> assert_cmd::assert::Assert {
    cargo_bin_cmd!("dupes")
        .args(["--similar", "--similarity", threshold])
        .arg(folder)
        .assert()
}

#[test]
fn copies_of_one_photo_form_one_group_with_the_best_quality_first() {
    let folder = TempDir::new().unwrap();
    save_original_with_copies(folder.path());
    save(
        &draw(test_images::other_scene_image(FULL_WIDTH, FULL_HEIGHT)),
        &folder.path().join("photos/other.png"),
    );

    let assert = run_similar(folder.path())
        .success()
        .stdout(predicate::str::contains("Найдено групп похожих фото: 1."))
        .stdout(predicate::str::contains("Группа 1: фото — 4"))
        .stdout(predicate::str::contains("other.png").not())
        .stderr(predicate::str::is_empty());

    let output = String::from_utf8(assert.get_output().stdout.clone()).unwrap();
    let group_lines: Vec<&str> = output
        .lines()
        .skip_while(|line| !line.starts_with("Группа 1"))
        .skip(1)
        .take_while(|line| line.starts_with("  "))
        .collect();
    assert_eq!(group_lines.len(), COPIES_OF_ORIGINAL + 1, "{output}");
    assert!(
        group_lines[0].contains("original.png — 640×480"),
        "{output}"
    );
    assert!(group_lines[0].ends_with("(лучшее качество)"), "{output}");
    assert!(group_lines[1].contains("copy.jpg — 160×120"), "{output}");
    assert!(group_lines[2].contains("copy.webp — 320×240"), "{output}");
    assert!(
        group_lines[3].contains("recompressed.jpg — 640×480"),
        "{output}"
    );
    assert!(output.contains("освободится"), "{output}");
}

#[test]
fn reports_when_there_are_no_similar_photos_and_ignores_identical_text_files() {
    let folder = TempDir::new().unwrap();
    save(
        &draw(test_images::scene_image(FULL_WIDTH, FULL_HEIGHT)),
        &folder.path().join("scene.png"),
    );
    save(
        &draw(test_images::other_scene_image(FULL_WIDTH, FULL_HEIGHT)),
        &folder.path().join("other.png"),
    );
    fs::write(folder.path().join("a.txt"), "одинаковый текст").unwrap();
    fs::write(folder.path().join("b.txt"), "одинаковый текст").unwrap();

    run_similar(folder.path())
        .success()
        .stdout("Похожих фото не найдено.\n")
        .stderr(predicate::str::is_empty());
}

#[test]
fn photo_with_a_small_mark_is_similar_by_default_but_not_at_full_strictness() {
    let folder = TempDir::new().unwrap();
    save(
        &draw(test_images::scene_image(FULL_WIDTH, FULL_HEIGHT)),
        &folder.path().join("clean.png"),
    );
    save(
        &draw(test_images::scene_with_mark_image(FULL_WIDTH, FULL_HEIGHT)),
        &folder.path().join("marked.png"),
    );

    run_similar(folder.path())
        .success()
        .stdout(predicate::str::contains("Группа 1: фото — 2"));
    run_similar_with_threshold(folder.path(), "100")
        .success()
        .stdout("Похожих фото не найдено.\n");
}

#[test]
fn similarity_outside_allowed_range_is_explained_with_exit_code_2() {
    let folder = TempDir::new().unwrap();

    for threshold in ["abc", "120", "49", "-5"] {
        run_similar_with_threshold(folder.path(), threshold)
            .code(2)
            .stdout(predicate::str::is_empty())
            .stderr(predicate::str::contains(format!(
                "«{threshold}» для --similarity"
            )))
            .stderr(predicate::str::contains("от 50 до 100"))
            .stderr(predicate::str::ends_with("Справка: dupes --help\n"));
    }
}

#[test]
fn similarity_flag_without_value_asks_for_a_number() {
    let folder = TempDir::new().unwrap();

    cargo_bin_cmd!("dupes")
        .arg("--similar")
        .arg(folder.path())
        .arg("--similarity")
        .assert()
        .code(2)
        .stdout(predicate::str::is_empty())
        .stderr(predicate::str::contains("После --similarity укажите"))
        .stderr(predicate::str::contains("от 50 до 100"))
        .stderr(predicate::str::ends_with("Справка: dupes --help\n"));
}

#[test]
fn similarity_without_similar_flag_asks_to_add_it() {
    let folder = TempDir::new().unwrap();

    cargo_bin_cmd!("dupes")
        .args(["--similarity", "90"])
        .arg(folder.path())
        .assert()
        .code(2)
        .stdout(predicate::str::is_empty())
        .stderr(predicate::str::contains("добавьте --similar"))
        .stderr(predicate::str::ends_with("Справка: dupes --help\n"));
}

#[test]
fn broken_photo_is_warned_about_and_other_groups_are_found() {
    let folder = TempDir::new().unwrap();
    save_original_with_copies(folder.path());
    let broken = folder.path().join("broken.jpg");
    fs::write(&broken, "это просто текст").unwrap();

    run_similar(folder.path())
        .success()
        .stdout(predicate::str::contains("Группа 1: фото — 4"))
        .stderr(format!(
            "Не удалось прочитать «{}»: файл повреждён или это не изображение. Пропускаю.\n",
            broken.display()
        ));
}

#[test]
fn empty_file_with_picture_extension_is_warned_about() {
    let folder = TempDir::new().unwrap();
    let empty = folder.path().join("empty.png");
    fs::write(&empty, "").unwrap();

    run_similar(folder.path())
        .success()
        .stdout("Похожих фото не найдено.\n")
        .stderr(damaged_photo_warning(&empty));
}

#[test]
fn truncated_photos_are_warned_about_as_damaged() {
    let folder = TempDir::new().unwrap();
    let truncated_webp = folder.path().join("cut.webp");
    fs::write(&truncated_webp, b"RIFF").unwrap();
    let truncated_png = folder.path().join("cut.png");
    let full_png = folder.path().join("full.png");
    save(
        &draw(test_images::scene_image(SMALL_WIDTH, SMALL_HEIGHT)),
        &full_png,
    );
    let full_bytes = fs::read(&full_png).unwrap();
    fs::write(&truncated_png, &full_bytes[..full_bytes.len() / 2]).unwrap();
    fs::remove_file(&full_png).unwrap();

    run_similar(folder.path())
        .success()
        .stdout("Похожих фото не найдено.\n")
        .stderr(damaged_photo_warning(&truncated_png).and(damaged_photo_warning(&truncated_webp)));
}

#[test]
fn repeated_similarity_flag_is_explained_with_exit_code_2() {
    let folder = TempDir::new().unwrap();

    cargo_bin_cmd!("dupes")
        .args(["--similar", "--similarity", "90", "--similarity", "80"])
        .arg(folder.path())
        .assert()
        .code(2)
        .stdout(predicate::str::is_empty())
        .stderr(
            "Параметр --similarity указан несколько раз — оставьте одно значение.\n\
             Справка: dupes --help\n",
        );
}

#[test]
fn two_runs_give_byte_identical_output() {
    let folder = TempDir::new().unwrap();
    save_original_with_copies(folder.path());

    let first_run = run_similar(folder.path())
        .success()
        .get_output()
        .stdout
        .clone();
    let second_run = run_similar(folder.path())
        .success()
        .get_output()
        .stdout
        .clone();

    assert_eq!(first_run, second_run);
}

#[test]
fn without_similar_flag_photos_are_compared_only_as_exact_files() {
    let folder = TempDir::new().unwrap();
    save_original_with_copies(folder.path());

    cargo_bin_cmd!("dupes")
        .arg(folder.path())
        .assert()
        .success()
        .stdout("Одинаковых файлов не найдено.\n");
}

#[test]
fn exact_copies_of_a_photo_are_similar_too() {
    let folder = TempDir::new().unwrap();
    save(
        &draw(test_images::scene_image(FULL_WIDTH, FULL_HEIGHT)),
        &folder.path().join("a.png"),
    );
    fs::copy(folder.path().join("a.png"), folder.path().join("b.png")).unwrap();

    run_similar_with_threshold(folder.path(), "100")
        .success()
        .stdout(predicate::str::contains("Группа 1: фото — 2"));
}

fn noisy_scene(width: u32, height: u32) -> RgbImage {
    draw(test_images::scene_image(width, height))
}

fn noisy_other_scene(width: u32, height: u32) -> RgbImage {
    draw(test_images::other_scene_image(width, height))
}

#[test]
fn folder_without_pictures_and_folder_with_one_picture_have_no_similar_photos() {
    let empty_folder = TempDir::new().unwrap();
    let single_folder = TempDir::new().unwrap();
    save(
        &noisy_scene(SMALL_WIDTH, SMALL_HEIGHT),
        &single_folder.path().join("only.png"),
    );

    for folder in [&empty_folder, &single_folder] {
        run_similar(folder.path())
            .success()
            .stdout("Похожих фото не найдено.\n")
            .stderr(predicate::str::is_empty());
    }
}

#[test]
fn two_sets_of_copies_form_two_groups() {
    let folder = TempDir::new().unwrap();
    for (name, image) in [
        ("scene", noisy_scene(FULL_WIDTH, FULL_HEIGHT)),
        ("other", noisy_other_scene(FULL_WIDTH, FULL_HEIGHT)),
    ] {
        save(&image, &folder.path().join(format!("{name}.png")));
        save_jpeg(
            &image,
            &folder.path().join(format!("{name}.jpg")),
            GOOD_JPEG_QUALITY,
        );
    }

    run_similar(folder.path())
        .success()
        .stdout(predicate::str::contains("Найдено групп похожих фото: 2."))
        .stdout(predicate::str::contains("Группа 1: фото — 2"))
        .stdout(predicate::str::contains("Группа 2: фото — 2"));
}

#[test]
fn similarity_bounds_50_and_100_are_accepted() {
    let folder = TempDir::new().unwrap();

    for threshold in ["50", "100"] {
        run_similar_with_threshold(folder.path(), threshold).success();
    }
}

#[test]
fn uppercase_extension_is_a_photo_and_gif_is_silently_ignored() {
    let folder = TempDir::new().unwrap();
    let image = noisy_scene(SMALL_WIDTH, SMALL_HEIGHT);
    save(&image, &folder.path().join("lower.png"));
    save_jpeg(&image, &folder.path().join("UPPER.JPG"), GOOD_JPEG_QUALITY);
    fs::write(folder.path().join("anim.gif"), "GIF89a не картинка").unwrap();

    run_similar(folder.path())
        .success()
        .stdout(predicate::str::contains("Группа 1: фото — 2"))
        .stdout(predicate::str::contains("UPPER.JPG"))
        .stdout(predicate::str::contains("anim.gif").not())
        .stderr(predicate::str::is_empty());
}
