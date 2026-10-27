use super::*;

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

#[test]
fn offsets_follow_the_whole_stream_even_after_trimming() {
    let mut replay = ReplayBuffer::new(8);
    assert_eq!(replay.push(b"hello"), 0);
    assert_eq!(replay.push(b" world"), 5);
    assert_eq!(replay.end(), 11);
    let (bytes, end) = replay.snapshot();
    assert_eq!(end, 11);
    assert!(bytes.len() <= 8);
    assert!(text(&bytes).ends_with("world"));
}

/// Pi and other full-screen CLIs switch to the alternate screen once at startup and
/// repaint it afterwards. Once that switch scrolls out of the bounded buffer, the
/// replay must still open the alternate screen, or each repaint lands in the normal
/// buffer's history.
#[test]
fn trimmed_replay_restores_the_alternate_screen_and_input_modes() {
    let mut replay = ReplayBuffer::new(64);
    replay.push(b"\x1b[?1049h\x1b[?7l\x1b[?1000h\x1b[?1003h\x1b[?1006h\x1b[?2004h\x1b[?25l");
    for frame in 0..40 {
        replay.push(format!("\x1b[H\x1b[2Kframe {frame}").as_bytes());
    }
    let (bytes, _) = replay.snapshot();
    let restored = text(&bytes);
    assert!(restored.starts_with("\x1b[?1049h"), "replay should reopen the alternate screen: {restored:?}");
    for mode in ["\x1b[?7l", "\x1b[?1000h", "\x1b[?1003h", "\x1b[?1006h", "\x1b[?2004h", "\x1b[?25l"] {
        assert!(restored.contains(mode), "missing {mode:?} in {restored:?}");
    }
    assert!(restored.ends_with("frame 39"));
}

#[test]
fn modes_reset_after_leaving_them_are_not_restored() {
    let mut replay = ReplayBuffer::new(16);
    replay.push(b"\x1b[?1049h\x1b[?1000;1006h");
    replay.push(b"\x1b[?1000;1006l\x1b[?1049l");
    replay.push(b"plain shell output that is long enough to trim");
    let (bytes, _) = replay.snapshot();
    let restored = text(&bytes);
    assert!(!restored.contains("\x1b[?"), "nothing should be restored: {restored:?}");
}

#[test]
fn a_full_reset_clears_recorded_modes() {
    let mut tracker = ModeTracker::default();
    tracker.feed(b"\x1b[?1049h\x1b[?2004h");
    assert!(tracker.alternate_screen());
    tracker.feed(b"\x1bc");
    assert!(!tracker.alternate_screen());
    assert_eq!(tracker.mode(2004), Some(false));
}

#[test]
fn mode_switches_split_across_reads_are_recognised() {
    let mut tracker = ModeTracker::default();
    tracker.feed(b"\x1b[?10");
    tracker.feed(b"49");
    assert!(!tracker.alternate_screen());
    tracker.feed(b"h");
    assert!(tracker.alternate_screen());
}

#[test]
fn strings_do_not_leak_mode_switches() {
    let mut tracker = ModeTracker::default();
    tracker.feed(b"\x1b]0;title \x1b[?1049h\x07");
    assert!(!tracker.alternate_screen());
    tracker.feed(b"\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\");
    assert!(tracker.at_boundary());
}

#[test]
fn trimmed_replay_starts_outside_an_escape_sequence() {
    let mut replay = ReplayBuffer::new(10);
    replay.push(b"0123456789");
    // The trim point lands inside the CSI parameters.
    replay.push(b"\x1b[38;2;10;20;30mX");
    let (bytes, _) = replay.snapshot();
    let restored = text(&bytes);
    assert!(!restored.starts_with(';') && !restored.starts_with('2') && !restored.starts_with('m'), "{restored:?}");
    assert!(restored.ends_with('X'));
}

#[test]
fn trimmed_replay_does_not_start_inside_a_utf8_character() {
    let mut replay = ReplayBuffer::new(4);
    replay.push("ab中文".as_bytes());
    let (bytes, _) = replay.snapshot();
    assert!(std::str::from_utf8(&bytes).is_ok(), "{bytes:?}");
    assert!(text(&bytes).ends_with('文'));
}
