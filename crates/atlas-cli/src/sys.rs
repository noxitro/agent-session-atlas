//! OS とのやりとりの小さな道具(TS 版では Node が持っていたもの): プロセスがあるか、黒い窓の幅・入力の捨て方・Ctrl+C、
//! PowerShell に渡すスクリプトの -EncodedCommand(UTF-16LE の base64)。

use std::sync::Mutex;

/// プロセスがあるか(`process.kill(pid, 0)` が通るか、EPERM で失敗するか)
pub fn alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ACCESS_DENIED, STILL_ACTIVE};
        use windows_sys::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
        // SAFETY: OpenProcess は失敗すると null を返す。開けたハンドルは閉じる
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if h.is_null() {
                // 別の利用者のプロセスなどで開けない(あるが触れない。Node の EPERM)
                return GetLastError() == ERROR_ACCESS_DENIED;
            }
            let mut code: u32 = 0;
            let ok = GetExitCodeProcess(h, &mut code) != 0;
            CloseHandle(h);
            !ok || code == STILL_ACTIVE as u32
        }
    }
    #[cfg(unix)]
    {
        // SAFETY: シグナル 0 は送らずに確かめるだけ
        let r = unsafe { libc::kill(pid as libc::pid_t, 0) };
        r == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
    #[cfg(not(any(windows, unix)))]
    {
        true
    }
}

/// 黒い窓の幅(分からなければ None)
pub fn terminal_columns() -> Option<u16> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::Console::{GetConsoleScreenBufferInfo, GetStdHandle, CONSOLE_SCREEN_BUFFER_INFO, STD_OUTPUT_HANDLE};
        // SAFETY: 情報を受け取る構造体を渡すだけ
        unsafe {
            let h = GetStdHandle(STD_OUTPUT_HANDLE);
            let mut info: CONSOLE_SCREEN_BUFFER_INFO = std::mem::zeroed();
            if GetConsoleScreenBufferInfo(h, &mut info) != 0 {
                let w = info.srWindow.Right - info.srWindow.Left + 1;
                return (w > 0).then_some(w as u16);
            }
        }
        None
    }
    #[cfg(unix)]
    {
        // SAFETY: winsize を受け取るだけ
        unsafe {
            let mut ws: libc::winsize = std::mem::zeroed();
            if libc::ioctl(1, libc::TIOCGWINSZ, &mut ws) == 0 && ws.ws_col > 0 {
                return Some(ws.ws_col);
            }
        }
        None
    }
    #[cfg(not(any(windows, unix)))]
    {
        None
    }
}

/// 出力の制御文字(行の書き換えに使う ESC [ … )を、Windows の古い黒い窓(conhost)でも効くようにする。端末でなければ何もしない
pub fn enable_vt_output() {
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::Console::{GetConsoleMode, GetStdHandle, SetConsoleMode, ENABLE_VIRTUAL_TERMINAL_PROCESSING, STD_OUTPUT_HANDLE};
        // SAFETY: 今のモードに 1 つ足すだけ
        unsafe {
            let h = GetStdHandle(STD_OUTPUT_HANDLE);
            let mut mode = 0;
            if GetConsoleMode(h, &mut mode) != 0 {
                SetConsoleMode(h, mode | ENABLE_VIRTUAL_TERMINAL_PROCESSING);
            }
        }
    }
}

/// 黒い窓の入力にたまっている(尋ねていない間に打った)キーを捨てる。端末でなければ何もしない
pub fn discard_pending_input() {
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::Console::{FlushConsoleInputBuffer, GetConsoleMode, GetStdHandle, STD_INPUT_HANDLE};
        // SAFETY: 端末の入力のときだけ捨てる
        unsafe {
            let h = GetStdHandle(STD_INPUT_HANDLE);
            let mut mode = 0;
            if GetConsoleMode(h, &mut mode) != 0 {
                FlushConsoleInputBuffer(h);
            }
        }
    }
    #[cfg(unix)]
    {
        // SAFETY: 端末でなければ失敗するだけ
        unsafe {
            libc::tcflush(0, libc::TCIFLUSH);
        }
    }
}

type CtrlC = Box<dyn Fn() + Send + Sync>;
static CTRL_C: Mutex<Option<CtrlC>> = Mutex::new(None);

#[cfg(windows)]
unsafe extern "system" fn on_ctrl(kind: u32) -> windows_sys::core::BOOL {
    use windows_sys::Win32::System::Console::{CTRL_BREAK_EVENT, CTRL_C_EVENT};
    if kind == CTRL_C_EVENT || kind == CTRL_BREAK_EVENT {
        if let Ok(g) = CTRL_C.lock() {
            if let Some(f) = g.as_ref() {
                f();
            }
        }
        std::process::exit(130);
    }
    0
}

#[cfg(unix)]
extern "C" fn on_sigint(_: libc::c_int) {
    if let Ok(g) = CTRL_C.try_lock() {
        if let Some(f) = g.as_ref() {
            f();
        }
    }
    std::process::exit(130);
}

/// Ctrl+C で終わるときに、後始末(書き換えていた 1 行を消す・作業中の印を外す)をしてから、終了コード 130 で終わる
pub fn on_ctrl_c(f: impl Fn() + Send + Sync + 'static) {
    if let Ok(mut g) = CTRL_C.lock() {
        *g = Some(Box::new(f));
    }
    #[cfg(windows)]
    // SAFETY: 終わるまで残る関数を登録する
    unsafe {
        windows_sys::Win32::System::Console::SetConsoleCtrlHandler(Some(on_ctrl), 1);
    }
    #[cfg(unix)]
    // SAFETY: 終わるまで残る関数を登録する
    unsafe {
        libc::signal(libc::SIGINT, on_sigint as *const () as libc::sighandler_t);
    }
}

/// base64(PowerShell の -EncodedCommand と同じ、詰め物の = 付き)
pub fn base64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for c in data.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        out.push(T[(n >> 18 & 63) as usize] as char);
        out.push(T[(n >> 12 & 63) as usize] as char);
        out.push(if c.len() > 1 { T[(n >> 6 & 63) as usize] as char } else { '=' });
        out.push(if c.len() > 2 { T[(n & 63) as usize] as char } else { '=' });
    }
    out
}

/// PowerShell の -EncodedCommand に渡す形(UTF-16LE の base64。`Buffer.from(s, 'utf16le').toString('base64')`)
pub fn encoded_command(script: &str) -> String {
    let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    base64(&bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_like_node() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(encoded_command("ab"), "YQBiAA==");
        assert!(alive(std::process::id()));
    }
}
