use std::path::PathBuf;

use clap::builder::RangedI64ValueParser;
use clap::error::{ContextKind, ContextValue, ErrorKind};
use clap::{ArgAction, Parser, value_parser};

use crate::similar::{DEFAULT_SIMILARITY_PERCENT, MAX_SIMILARITY_PERCENT, MIN_SIMILARITY_PERCENT};

const HELP_HINT: &str = "Справка: dupes --help";
const SIMILAR_FLAG: &str = "--similar";
const SIMILARITY_FLAG: &str = "--similarity";
const GENERIC_ARGUMENTS_MESSAGE: &str = "Не удалось разобрать аргументы командной строки.";
const EXAMPLE_SIMILARITY_PERCENT: u8 = 85;

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
    about = "Находит одинаковые файлы и похожие фото в папке и показывает, сколько места освободится.",
    override_usage = "dupes [ПАРАМЕТРЫ] <ПАПКА>",
    disable_help_flag = true,
    help_template = HELP_TEMPLATE
)]
pub struct Cli {
    /// Папка, в которой искать
    #[arg(value_name = "ПАПКА")]
    pub folder: PathBuf,

    /// Искать похожие фото вместо одинаковых файлов: одно и то же изображение в другом размере или качестве (JPEG, PNG и WebP)
    #[arg(long)]
    similar: bool,

    /// Порог похожести: насколько фото должны совпадать, чтобы считаться похожими, — в процентах, от 50 до 100. Чем больше число, тем строже отбор: при 100 похожими считаются только почти неотличимые фото, при меньших значениях — и фото с заметными отличиями, но тогда в группу могут попасть разные снимки одной сцены. По умолчанию — 90
    #[arg(
        long,
        value_name = "ПРОЦЕНТ",
        requires = "similar",
        allow_negative_numbers = true,
        value_parser = similarity_parser()
    )]
    similarity: Option<u8>,

    /// Показать эту справку
    #[arg(short, long, action = ArgAction::Help)]
    help: Option<bool>,
}

/// Что именно искать в папке.
#[derive(Debug, PartialEq, Eq)]
pub enum SearchMode {
    ExactDuplicates,
    SimilarPhotos { similarity_percent: u8 },
}

impl Cli {
    pub fn search_mode(&self) -> SearchMode {
        if !self.similar {
            return SearchMode::ExactDuplicates;
        }

        SearchMode::SimilarPhotos {
            similarity_percent: self.similarity.unwrap_or(DEFAULT_SIMILARITY_PERCENT),
        }
    }
}

fn similarity_parser() -> RangedI64ValueParser<u8> {
    value_parser!(u8).range(i64::from(MIN_SIMILARITY_PERCENT)..=i64::from(MAX_SIMILARITY_PERCENT))
}

pub fn argument_error_message(err: &clap::Error) -> String {
    let problem = match err.kind() {
        ErrorKind::MissingRequiredArgument => missing_argument_message(err),
        ErrorKind::ValueValidation | ErrorKind::InvalidValue if is_about_similarity(err) => {
            similarity_value_message(err)
        }
        ErrorKind::ArgumentConflict => repeated_argument_message(err),
        ErrorKind::UnknownArgument => unknown_argument_message(err),
        _ => GENERIC_ARGUMENTS_MESSAGE.to_string(),
    };

    format!("{problem}\n{HELP_HINT}")
}

fn missing_argument_message(err: &clap::Error) -> String {
    let missing_arguments = context_strings(err, ContextKind::InvalidArg);
    if missing_arguments.contains(&SIMILAR_FLAG) {
        return format!(
            "{SIMILARITY_FLAG} задаёт порог только для поиска похожих фото — добавьте {SIMILAR_FLAG}. \
             Например: {}",
            similarity_example()
        );
    }

    "Укажите папку, в которой искать одинаковые файлы или похожие фото. Например: dupes ~/Загрузки"
        .to_string()
}

fn repeated_argument_message(err: &clap::Error) -> String {
    match err.get(ContextKind::InvalidArg) {
        Some(argument) => {
            let flag = argument.to_string();
            let flag_name = flag.split_whitespace().next().unwrap_or(&flag);
            format!("Параметр {flag_name} указан несколько раз — оставьте одно значение.")
        }
        None => GENERIC_ARGUMENTS_MESSAGE.to_string(),
    }
}

fn is_about_similarity(err: &clap::Error) -> bool {
    let invalid_arguments = context_strings(err, ContextKind::InvalidArg);
    invalid_arguments
        .iter()
        .any(|argument| argument.starts_with(SIMILARITY_FLAG))
}

fn similarity_value_message(err: &clap::Error) -> String {
    let range_hint = format!(
        "целое число от {MIN_SIMILARITY_PERCENT} до {MAX_SIMILARITY_PERCENT} — \
         насколько фото должны совпадать, в процентах. Например: {}",
        similarity_example()
    );
    let values = context_strings(err, ContextKind::InvalidValue);

    match values.first().filter(|value| !value.is_empty()) {
        Some(value) => {
            format!("Неподходящее значение «{value}» для {SIMILARITY_FLAG}: нужно {range_hint}")
        }
        None => format!("После {SIMILARITY_FLAG} укажите {range_hint}"),
    }
}

fn similarity_example() -> String {
    format!("dupes {SIMILAR_FLAG} {SIMILARITY_FLAG} {EXAMPLE_SIMILARITY_PERCENT} ~/Фото")
}

/// Значения контекста ошибки clap как строки: одно значение приходит строкой, несколько — списком.
fn context_strings(err: &clap::Error, kind: ContextKind) -> Vec<&str> {
    match err.get(kind) {
        Some(ContextValue::String(value)) => vec![value.as_str()],
        Some(ContextValue::Strings(values)) => values.iter().map(String::as_str).collect(),
        _ => Vec::new(),
    }
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
    use clap::CommandFactory;

    fn parse_error(arguments: &[&str]) -> clap::Error {
        Cli::try_parse_from(arguments).err().unwrap()
    }

    #[test]
    fn missing_folder_asks_to_specify_it() {
        let message = argument_error_message(&parse_error(&["dupes"]));

        assert_eq!(
            message,
            "Укажите папку, в которой искать одинаковые файлы или похожие фото. Например: dupes ~/Загрузки\nСправка: dupes --help"
        );
    }

    fn similarity_range_hint() -> String {
        format!("целое число от {MIN_SIMILARITY_PERCENT} до {MAX_SIMILARITY_PERCENT}")
    }

    #[test]
    fn similarity_that_is_not_a_number_is_explained() {
        let error = parse_error(&["dupes", "--similar", "--similarity", "abc", "folder"]);

        let message = argument_error_message(&error);

        assert_eq!(
            message,
            "Неподходящее значение «abc» для --similarity: нужно целое число от 50 до 100 — \
             насколько фото должны совпадать, в процентах. Например: dupes --similar --similarity 85 ~/Фото\n\
             Справка: dupes --help"
        );
    }

    #[test]
    fn similarity_outside_range_is_explained() {
        for value in ["120", "49", "-5"] {
            let error = parse_error(&["dupes", "--similar", "--similarity", value, "folder"]);

            let message = argument_error_message(&error);

            assert!(
                message.contains(&format!("«{value}» для --similarity")),
                "{message}"
            );
            assert!(message.contains(&similarity_range_hint()), "{message}");
            assert!(message.ends_with("Справка: dupes --help"), "{message}");
        }
    }

    #[test]
    fn similarity_without_value_asks_for_it() {
        let error = parse_error(&["dupes", "--similar", "folder", "--similarity"]);

        let message = argument_error_message(&error);

        assert_eq!(
            message,
            "После --similarity укажите целое число от 50 до 100 — \
             насколько фото должны совпадать, в процентах. Например: dupes --similar --similarity 85 ~/Фото\n\
             Справка: dupes --help"
        );
    }

    #[test]
    fn similarity_without_similar_asks_to_add_it() {
        let error = parse_error(&["dupes", "--similarity", "90", "folder"]);

        let message = argument_error_message(&error);

        assert_eq!(
            message,
            "--similarity задаёт порог только для поиска похожих фото — добавьте --similar. \
             Например: dupes --similar --similarity 85 ~/Фото\n\
             Справка: dupes --help"
        );
    }

    #[test]
    fn repeated_similarity_is_explained() {
        let error = parse_error(&[
            "dupes",
            "--similar",
            "--similarity",
            "90",
            "--similarity",
            "80",
            "folder",
        ]);

        let message = argument_error_message(&error);

        assert_eq!(
            message,
            "Параметр --similarity указан несколько раз — оставьте одно значение.\nСправка: dupes --help"
        );
    }

    #[test]
    fn repeated_similar_flag_is_explained() {
        let error = parse_error(&["dupes", "--similar", "--similar", "folder"]);

        let message = argument_error_message(&error);

        assert!(
            message.starts_with("Параметр --similar указан несколько раз"),
            "{message}"
        );
    }

    #[test]
    fn search_mode_is_exact_duplicates_without_similar() {
        let cli = Cli::try_parse_from(["dupes", "folder"]).unwrap();

        assert_eq!(cli.search_mode(), SearchMode::ExactDuplicates);
    }

    #[test]
    fn search_mode_uses_default_similarity() {
        let cli = Cli::try_parse_from(["dupes", "--similar", "folder"]).unwrap();

        assert_eq!(
            cli.search_mode(),
            SearchMode::SimilarPhotos {
                similarity_percent: DEFAULT_SIMILARITY_PERCENT
            }
        );
    }

    #[test]
    fn search_mode_uses_given_similarity_within_range() {
        for percent in [MIN_SIMILARITY_PERCENT, 73, MAX_SIMILARITY_PERCENT] {
            let cli = Cli::try_parse_from([
                "dupes",
                "--similar",
                "--similarity",
                &percent.to_string(),
                "folder",
            ])
            .unwrap();

            assert_eq!(
                cli.search_mode(),
                SearchMode::SimilarPhotos {
                    similarity_percent: percent
                }
            );
        }
    }

    #[test]
    fn help_states_similarity_limits_and_default_from_constants() {
        let help = Cli::command().render_help().to_string();

        let expected_range = format!("от {MIN_SIMILARITY_PERCENT} до {MAX_SIMILARITY_PERCENT}");
        let expected_default = format!("По умолчанию — {DEFAULT_SIMILARITY_PERCENT}");
        assert!(help.contains(&expected_range), "{help}");
        assert!(help.contains(&expected_default), "{help}");
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
            format!("{GENERIC_ARGUMENTS_MESSAGE}\nСправка: dupes --help")
        );
    }
}
