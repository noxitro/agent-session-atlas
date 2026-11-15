//! 表示用のプロジェクト名。ホームディレクトリを ~ に短くする。

use regex::Regex;
use std::sync::LazyLock;

static HOME_WIN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z]:\\[Uu][Ss][Ee][Rr][Ss]\\[^\\]+").unwrap());
static HOME_POSIX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^/(?:Users|home)/[^/]+").unwrap());

/// 表示用のプロジェクト名: ホームディレクトリを ~ に短縮
pub fn short_project_label(key: &str) -> String {
    let a = HOME_WIN.replace(key, "~");
    HOME_POSIX.replace(&a, "~").into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_labels() {
        assert_eq!(short_project_label("/home/me/.copilot/chats/c1"), "~/.copilot/chats/c1");
        assert_eq!(short_project_label("quokka/x"), "quokka/x");
        let win = format!("C:\\{}\\someone\\proj", "Users");
        assert_eq!(short_project_label(&win), "~\\proj");
        assert_eq!(short_project_label(&win.replace("Users", "USERS")), "~\\proj");
    }
}
