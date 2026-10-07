use std::fmt;
use std::io;
use std::path::PathBuf;

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

impl fmt::Display for SkipReason {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SkipReason::AccessDenied => write!(formatter, "нет прав на чтение"),
            SkipReason::Vanished => write!(formatter, "файл исчез во время проверки"),
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
    fn reasons_are_described_in_russian() {
        assert_eq!(SkipReason::AccessDenied.to_string(), "нет прав на чтение");
        assert_eq!(
            SkipReason::Vanished.to_string(),
            "файл исчез во время проверки"
        );
        assert_eq!(
            SkipReason::Unreadable("сбой диска".to_string()).to_string(),
            "непредвиденная ошибка (системное сообщение: сбой диска)"
        );
    }
}
