//! 並べて動かす(TS 版の mapLimit / someLimit)。共有フォルダ(SMB)は 1 回の問い合わせごとに往復の待ちがあるので、
//! ファイルの操作をスレッドで同時に走らせる。結果は元の順で返す。

use anyhow::Result;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

/// items を limit 個ずつ並べて f に通し、結果を元の順で返す。1 つでも失敗したら、残りは始めず、動いているものを待ってから最初の失敗を返す。
/// f の 2 つ目の引数は、並べて動かしている枠の番号(0..limit。同じ時に同じ番号の f は動かない)
pub fn map_limit<T: Sync, R: Send>(items: &[T], limit: usize, f: impl Fn(&T, usize) -> Result<R> + Sync) -> Result<Vec<R>> {
    let n = items.len();
    let workers = limit.min(n).max(1);
    if n <= 1 || workers == 1 {
        return items.iter().map(|x| f(x, 0)).collect();
    }
    let next = AtomicUsize::new(0);
    let stop = AtomicBool::new(false);
    let failed: Mutex<Option<anyhow::Error>> = Mutex::new(None);
    let parts: Vec<Vec<(usize, R)>> = std::thread::scope(|s| {
        let handles: Vec<_> = (0..workers)
            .map(|w| {
                let (next, stop, failed, f) = (&next, &stop, &failed, &f);
                s.spawn(move || {
                    let mut local = Vec::new();
                    while !stop.load(Ordering::SeqCst) {
                        let i = next.fetch_add(1, Ordering::SeqCst);
                        if i >= n {
                            break;
                        }
                        match f(&items[i], w) {
                            Ok(r) => local.push((i, r)),
                            Err(e) => {
                                stop.store(true, Ordering::SeqCst);
                                failed.lock().unwrap().get_or_insert(e);
                            }
                        }
                    }
                    local
                })
            })
            .collect();
        handles.into_iter().map(|h| h.join().unwrap_or_else(|p| std::panic::resume_unwind(p))).collect()
    });
    if let Some(e) = failed.into_inner().unwrap() {
        return Err(e);
    }
    let mut out: Vec<Option<R>> = (0..n).map(|_| None).collect();
    for (i, r) in parts.into_iter().flatten() {
        out[i] = Some(r);
    }
    Ok(out.into_iter().map(|r| r.expect("map_limit: all items done")).collect())
}

/// 失敗しない f を並べて動かす
pub fn par_map<T: Sync, R: Send>(items: &[T], limit: usize, f: impl Fn(&T) -> R + Sync) -> Vec<R> {
    map_limit(items, limit, |x, _| Ok(f(x))).expect("par_map does not fail")
}

/// pred が true になるものがあるか。limit 個ずつ並べて確かめ、見つかった組で止める
pub fn some_limit<T: Sync>(items: &[T], limit: usize, pred: impl Fn(&T) -> bool + Sync) -> bool {
    items.chunks(limit.max(1)).any(|chunk| par_map(chunk, limit, &pred).into_iter().any(|b| b))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_order_and_stops_on_failure() {
        let items: Vec<usize> = (0..100).collect();
        let out = map_limit(&items, 16, |x, w| {
            assert!(w < 16);
            Ok(x * 2)
        })
        .unwrap();
        assert_eq!(out, items.iter().map(|x| x * 2).collect::<Vec<_>>());
        let e = map_limit(&items, 4, |x, _| if *x == 10 { anyhow::bail!("ten") } else { Ok(*x) }).unwrap_err();
        assert_eq!(e.to_string(), "ten");
        assert!(some_limit(&items, 16, |x| *x == 99));
        assert!(!some_limit(&items, 16, |x| *x == 100));
    }
}
