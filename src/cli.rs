use std::path::PathBuf;

use clap::error::{ContextKind, ErrorKind};
use clap::{ArgAction, Parser};

const HELP_HINT: &str = "Справка: dupes --help";

// Заголовки заданы шаблоном, потому что clap по умолчанию выводит их по-английски.
const HELP_TEMPLATE: &str = "\
{about}

Использование: {usage}

Аргументы:
{positionals}

Параметры:
{options}
";

#[derive(Parser)]
#[command(
    name = "dupes",
    about = "Находит одинаковые файлы в папке и показывает, сколько места освободится.",
    disable_help_flag = true,
    help_template = HELP_TEMPLATE
)]
pub struct Cli {
    /// Папка, в которой искать одинаковые файлы
    #[arg(value_name = "ПАПКА")]
    pub folder: PathBuf,

    /// Показать эту справку
    #[arg(short, long, action = ArgAction::Help)]
    help: Option<bool>,
}

pub fn argument_error_message(err: &clap::Error) -> String {
    let problem = match err.kind() {
        ErrorKind::MissingRequiredArgument => {
            "Укажите папку, в которой искать одинаковые файлы. Например: dupes ~/Загрузки"
                .to_string()
        }
        ErrorKind::UnknownArgument => unknown_argument_message(err),
        _ => "Не удалось разобрать аргументы командной строки.".to_string(),
    };

    format!("{problem}\n{HELP_HINT}")
}

fn unknown_argument_message(err: &clap::Error) -> String {
    match err.get(ContextKind::InvalidArg) {
        Some(argument) => format!("Лишний или неизвестный аргумент «{argument}»."),
        None => "Лишний или неизвестный аргумент.".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_error(arguments: &[&str]) -> clap::Error {
        Cli::try_parse_from(arguments).err().unwrap()
    }

    #[test]
    fn missing_folder_asks_to_specify_it() {
        let message = argument_error_message(&parse_error(&["dupes"]));

        assert_eq!(
            message,
            "Укажите папку, в которой искать одинаковые файлы. Например: dupes ~/Загрузки\nСправка: dupes --help"
        );
    }

    #[test]
    fn unknown_flag_is_named_in_message() {
        let message = argument_error_message(&parse_error(&["dupes", "--bogus", "folder"]));

        assert!(message.contains("«--bogus»"), "{message}");
        assert!(message.ends_with("Справка: dupes --help"));
    }

    #[test]
    fn extra_argument_is_named_in_message() {
        let message = argument_error_message(&parse_error(&["dupes", "one", "two"]));

        assert!(message.contains("«two»"), "{message}");
    }

    #[test]
    fn other_errors_get_generic_message() {
        let error = clap::Error::new(ErrorKind::InvalidValue);

        let message = argument_error_message(&error);

        assert_eq!(
            message,
            "Не удалось разобрать аргументы командной строки.\nСправка: dupes --help"
        );
    }
}
