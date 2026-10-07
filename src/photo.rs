use std::path::Path;

use image::{DynamicImage, ImageError, ImageFormat, ImageReader};

use crate::perceptual_hash::PerceptualHash;
use crate::scan::ScannedFile;
use crate::skipped::{SkipReason, SkippedPath};

#[derive(Debug)]
pub struct Photo {
    pub file: ScannedFile,
    pub width: u32,
    pub height: u32,
    pub hash: PerceptualHash,
}

/// Фото отбираем по расширению: открывать каждый файл папки ради проверки формата слишком долго.
pub fn is_supported_photo(path: &Path) -> bool {
    ImageFormat::from_path(path).is_ok_and(|format| format.reading_enabled())
}

pub fn read_photo(file: ScannedFile) -> Result<Photo, SkippedPath> {
    let image = match decode_image(&file.path) {
        Ok(image) => image,
        Err(error) => {
            return Err(SkippedPath {
                reason: SkipReason::from(&error),
                path: file.path,
            });
        }
    };

    Ok(Photo {
        hash: PerceptualHash::of_image(&image),
        width: image.width(),
        height: image.height(),
        file,
    })
}

/// Формат берём по содержимому: расширение у файла может быть неверным.
/// Ограничения памяти оставлены по умолчанию из `image`: слишком большая картинка даёт
/// `ImageTooLarge`, а не съедает всю память и не роняет утилиту.
fn decode_image(path: &Path) -> Result<DynamicImage, ImageError> {
    let reader = ImageReader::open(path)?.with_guessed_format()?;
    reader.decode()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_images::scene_image;
    use std::fs;
    use std::path::PathBuf;
    use std::time::SystemTime;
    use tempfile::TempDir;

    const WIDTH: u32 = 64;
    const HEIGHT: u32 = 48;

    fn scanned(path: PathBuf) -> ScannedFile {
        let metadata = fs::metadata(&path).unwrap();
        ScannedFile::from_metadata(path, &metadata).unwrap()
    }

    #[test]
    fn photo_formats_are_recognised_by_extension_ignoring_case() {
        for name in ["a.jpg", "a.JPG", "a.jpeg", "a.png", "a.webp"] {
            assert!(is_supported_photo(Path::new(name)), "{name}");
        }
    }

    #[test]
    fn other_files_are_not_photos() {
        for name in ["a.txt", "a.gif", "photo"] {
            assert!(!is_supported_photo(Path::new(name)), "{name}");
        }
    }

    #[test]
    fn png_gives_its_dimensions_and_size() {
        let folder = TempDir::new().unwrap();
        let path = folder.path().join("picture.png");
        scene_image(WIDTH, HEIGHT).save(&path).unwrap();

        let photo = read_photo(scanned(path.clone())).unwrap();

        assert_eq!(photo.file.path, path);
        assert_eq!((photo.width, photo.height), (WIDTH, HEIGHT));
        assert_eq!(photo.file.size, fs::metadata(&path).unwrap().len());
    }

    #[test]
    fn format_is_taken_from_content_not_from_extension() {
        let folder = TempDir::new().unwrap();
        let path = folder.path().join("actually_png.jpg");
        scene_image(WIDTH, HEIGHT)
            .save_with_format(&path, ImageFormat::Png)
            .unwrap();

        let photo = read_photo(scanned(path)).unwrap();

        assert_eq!((photo.width, photo.height), (WIDTH, HEIGHT));
    }

    #[test]
    fn text_inside_jpg_is_a_damaged_image() {
        let folder = TempDir::new().unwrap();
        let path = folder.path().join("broken.jpg");
        fs::write(&path, "это не картинка").unwrap();

        let skipped = read_photo(scanned(path.clone())).unwrap_err();

        assert_eq!(skipped.reason, SkipReason::DamagedImage);
        assert_eq!(skipped.path, path);
    }

    #[test]
    fn vanished_file_is_reported_as_vanished() {
        let folder = TempDir::new().unwrap();
        let file = ScannedFile {
            path: folder.path().join("gone.png"),
            size: 0,
            modified: SystemTime::UNIX_EPOCH,
            identity: None,
        };

        let skipped = read_photo(file).unwrap_err();

        assert_eq!(skipped.reason, SkipReason::Vanished);
    }
}
