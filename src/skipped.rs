use std::fmt;
use std::io;
use std::path::PathBuf;

use image::ImageError;

/// Путь, который не удалось прочитать, и причина, по которой его пропустили.
#[derive(Debug)]
pub struct SkippedPath {
    pub path: PathBuf,
    pub reason: SkipReason,
}

#[derive(Debug, PartialEq, Eq)]
pub enum SkipReason {
    AccessDenied,
    Vanished,
    DamagedImage,
    UnsupportedImage,
    ImageTooLarge,
    Unreadable(String),
}

impl From<&io::Error> for SkipReason {
    fn from(error: &io::Error) -> Self {
        match error.kind() {
            io::ErrorKind::PermissionDenied => SkipReason::AccessDenied,
            io::ErrorKind::NotFound => SkipReason::Vanished,
            _ => SkipReason::Unreadable(error.to_string()),
        }
    }
}

impl From<&ImageError> for SkipReason {
    fn from(error: &ImageError) -> Self {
        match error {
            // Обрезанный или пустой файл читается до конца раньше, чем картинка закончилась.
            ImageError::IoError(io_error) if io_error.kind() == io::ErrorKind::UnexpectedEof => {
                SkipReason::DamagedImage
            }
            ImageError::IoError(io_error) => SkipReason::from(io_error),
            ImageError::Decoding(_) => SkipReason::DamagedImage,
            ImageError::Unsupported(_) => SkipReason::UnsupportedImage,
            ImageError::Limits(_) => SkipReason::ImageTooLarge,
            ImageError::Encoding(_) | ImageError::Parameter(_) => {
                SkipReason::Unreadable(error.to_string())
            }
        }
    }
}

impl fmt::Display for SkipReason {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SkipReason::AccessDenied => write!(formatter, "нет прав на чтение"),
            SkipReason::Vanished => write!(formatter, "файл исчез во время проверки"),
            SkipReason::DamagedImage => write!(formatter, "файл повреждён или это не изображение"),
            SkipReason::UnsupportedImage => {
                write!(formatter, "такой вид изображения не поддерживается")
            }
            SkipReason::ImageTooLarge => {
                write!(formatter, "изображение слишком большое для проверки")
            }
            SkipReason::Unreadable(system_message) => write!(
                formatter,
                "непредвиденная ошибка (системное сообщение: {system_message})"
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::error::{
        DecodingError, ImageFormatHint, LimitError, LimitErrorKind, ParameterError,
        ParameterErrorKind, UnsupportedError, UnsupportedErrorKind,
    };

    #[test]
    fn permission_denied_means_access_denied() {
        let error = io::Error::from(io::ErrorKind::PermissionDenied);

        assert_eq!(SkipReason::from(&error), SkipReason::AccessDenied);
    }

    #[test]
    fn not_found_means_vanished() {
        let error = io::Error::from(io::ErrorKind::NotFound);

        assert_eq!(SkipReason::from(&error), SkipReason::Vanished);
    }

    #[test]
    fn other_error_keeps_system_message() {
        let error = io::Error::from(io::ErrorKind::Other);

        let reason = SkipReason::from(&error);

        assert_eq!(reason, SkipReason::Unreadable(error.to_string()));
    }

    #[test]
    fn image_decoding_error_means_damaged_image() {
        let error = ImageError::Decoding(DecodingError::from_format_hint(ImageFormatHint::Unknown));

        assert_eq!(SkipReason::from(&error), SkipReason::DamagedImage);
    }

    #[test]
    fn image_unsupported_error_means_unsupported_image() {
        let error = ImageError::Unsupported(UnsupportedError::from_format_and_kind(
            ImageFormatHint::Unknown,
            UnsupportedErrorKind::Format(ImageFormatHint::Unknown),
        ));

        assert_eq!(SkipReason::from(&error), SkipReason::UnsupportedImage);
    }

    #[test]
    fn image_limits_error_means_image_too_large() {
        let error = ImageError::Limits(LimitError::from_kind(LimitErrorKind::InsufficientMemory));

        assert_eq!(SkipReason::from(&error), SkipReason::ImageTooLarge);
    }

    #[test]
    fn image_io_error_is_classified_like_plain_io_error() {
        let error = ImageError::IoError(io::Error::from(io::ErrorKind::NotFound));

        assert_eq!(SkipReason::from(&error), SkipReason::Vanished);
    }

    #[test]
    fn image_cut_short_means_damaged_image() {
        let error = ImageError::IoError(io::Error::from(io::ErrorKind::UnexpectedEof));

        assert_eq!(SkipReason::from(&error), SkipReason::DamagedImage);
    }

    #[test]
    fn image_parameter_error_keeps_system_message() {
        let error = ImageError::Parameter(ParameterError::from_kind(
            ParameterErrorKind::DimensionMismatch,
        ));

        let reason = SkipReason::from(&error);

        assert_eq!(reason, SkipReason::Unreadable(error.to_string()));
    }

    #[test]
    fn reasons_are_described_in_russian() {
        assert_eq!(SkipReason::AccessDenied.to_string(), "нет прав на чтение");
        assert_eq!(
            SkipReason::Vanished.to_string(),
            "файл исчез во время проверки"
        );
        assert_eq!(
            SkipReason::DamagedImage.to_string(),
            "файл повреждён или это не изображение"
        );
        assert_eq!(
            SkipReason::UnsupportedImage.to_string(),
            "такой вид изображения не поддерживается"
        );
        assert_eq!(
            SkipReason::ImageTooLarge.to_string(),
            "изображение слишком большое для проверки"
        );
        assert_eq!(
            SkipReason::Unreadable("сбой диска".to_string()).to_string(),
            "непредвиденная ошибка (системное сообщение: сбой диска)"
        );
    }
}
