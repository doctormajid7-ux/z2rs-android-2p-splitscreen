//! Portrait two-player split: one frame, shown twice, the top copy turned
//! upside down.
//!
//! Two players sit at opposite ends of a portrait screen, so each looks at
//! half of it. They still play the *same* picture — the camera is shared and
//! nothing about the emulation changes — so the second copy is the first one
//! rotated 180°, which makes it upright for the player facing the other way.
//!
//! This is the display half only: a frontend that turns the split on hands the
//! presented frame to [`duplicate_rotated`] and doubles its texture height.
//! Nothing here reaches the game, the verification path or a netplay identity.

/// Height multiplier of the presented frame: 2 with the split on, 1 off.
#[must_use]
pub fn height_multiplier(on: bool) -> usize {
    if on {
        2
    } else {
        1
    }
}

/// Bytes the doubled portrait frame occupies for a `w * h` RGBA source.
#[must_use]
pub fn out_len(w: usize, h: usize, on: bool) -> usize {
    w * h * 4 * height_multiplier(on)
}

/// Write the doubled portrait frame into `dst`.
///
/// * `dst` top half (`w * h * 4` bytes) — `src` rotated 180°, upright for the
///   player sitting at the top of the screen.
/// * `dst` bottom half — `src`, byte for byte.
///
/// `src` is one RGBA frame of `w * h` pixels; `dst` must be exactly twice as
/// long. The split is off when nothing calls this, so a single-player session
/// never pays for the copy.
///
/// # Panics
/// When `src` is not `w * h * 4` bytes or `dst` is not twice that.
pub fn duplicate_rotated(src: &[u8], w: usize, h: usize, dst: &mut [u8]) {
    let single = frame_len(w, h, "duplicate_rotated");
    assert_eq!(
        src.len(),
        single,
        "duplicate_rotated: source is {} bytes, expected {w}x{h} RGBA = {single}",
        src.len()
    );
    assert_eq!(
        dst.len(),
        single * 2,
        "duplicate_rotated: destination is {} bytes, expected {}",
        dst.len(),
        single * 2
    );

    // Bottom half: the original, facing the player holding the screen the
    // right way up.
    dst[single..].copy_from_slice(src);
    let (top, _) = dst.split_at_mut(single);
    rotate_into(src, top, w, h);
}

/// [`duplicate_rotated`] for a frontend that only holds one buffer: grow it,
/// slide the frame down into the bottom half, then turn a copy of it into the
/// top half.
///
/// `buf` must be exactly one `w * h` RGBA frame on entry and becomes twice
/// that, with the original preserved in the lower half.
///
/// # Panics
/// When `buf` is not `w * h * 4` bytes.
pub fn duplicate_rotated_in_place(buf: &mut Vec<u8>, w: usize, h: usize) {
    let single = frame_len(w, h, "duplicate_rotated_in_place");
    assert_eq!(
        buf.len(),
        single,
        "duplicate_rotated_in_place: frame is {} bytes, expected {w}x{h} RGBA = {single}",
        buf.len()
    );
    buf.resize(single * 2, 0);
    // The frame ends up at the bottom; the gap it left becomes the top half.
    buf.copy_within(0..single, single);
    let (top, bottom) = buf.split_at_mut(single);
    rotate_into(bottom, top, w, h);
}

/// Bytes of one `w * h` RGBA frame, or panic with `who` in the message.
fn frame_len(w: usize, h: usize, who: &str) -> usize {
    w.checked_mul(h)
        .and_then(|n| n.checked_mul(4))
        .unwrap_or_else(|| panic!("{who}: frame size overflows usize ({w}x{h})"))
}

/// Write `src` into `dst` turned through 180°: row y of `dst` is the source's
/// last row, with its pixels running backwards too. Both are `w * h * 4`.
fn rotate_into(src: &[u8], dst: &mut [u8], w: usize, h: usize) {
    let row = w * 4;
    for y in 0..h {
        let source_row = &src[(h - 1 - y) * row..(h - y) * row];
        let out_row = &mut dst[y * row..(y + 1) * row];
        // One RGBA pixel is one `[u8; 4]`, so the rows are whole words and
        // the rotation is a word-by-word copy instead of a per-byte loop.
        let (out_pixels, out_tail) = out_row.as_chunks_mut::<4>();
        let (src_pixels, src_tail) = source_row.as_chunks::<4>();
        debug_assert!(
            out_tail.is_empty() && src_tail.is_empty(),
            "rows are whole RGBA pixels"
        );
        for (out_px, src_px) in out_pixels.iter_mut().zip(src_pixels.iter().rev()) {
            *out_px = *src_px;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Four distinct pixels, so every destination position is checkable.
    fn frame() -> Vec<u8> {
        // 2x2 RGBA: A B / C D
        let mut v = Vec::new();
        for px in [
            [1u8, 0, 0, 255],
            [2, 0, 0, 255],
            [3, 0, 0, 255],
            [4, 0, 0, 255],
        ] {
            v.extend_from_slice(&px);
        }
        v
    }

    fn px(buf: &[u8], i: usize) -> u8 {
        buf[i * 4]
    }

    #[test]
    fn multiplier_and_len_follow_the_flag() {
        assert_eq!(height_multiplier(false), 1);
        assert_eq!(height_multiplier(true), 2);
        assert_eq!(out_len(2, 2, false), 16);
        assert_eq!(out_len(2, 2, true), 32);
    }

    #[test]
    fn bottom_half_is_the_original() {
        let src = frame();
        let mut dst = vec![0; 32];
        duplicate_rotated(&src, 2, 2, &mut dst);
        assert_eq!(&dst[16..], &src[..], "bottom half is a byte-for-byte copy");
    }

    #[test]
    fn top_half_is_rotated_180() {
        let src = frame();
        let mut dst = vec![0; 32];
        duplicate_rotated(&src, 2, 2, &mut dst);
        // A B / C D  ->  rotated through 180°: D C / B A
        let want = [4u8, 3, 2, 1];
        for (i, w) in want.iter().enumerate() {
            assert_eq!(px(&dst, i), *w, "top pixel {i}");
        }
    }

    #[test]
    fn the_two_halves_never_agree_unless_the_frame_is_flat() {
        let src = frame();
        let mut dst = vec![0; 32];
        duplicate_rotated(&src, 2, 2, &mut dst);
        assert_ne!(&dst[..16], &dst[16..]);
    }

    #[test]
    fn a_wide_frame_rotates_row_by_row() {
        // 4x2, rows distinguishable by their first pixel: 1..4 / 5..8
        let mut src = Vec::new();
        for i in 1u8..=8 {
            src.extend_from_slice(&[i, i, i, 255]);
        }
        let mut dst = vec![0; src.len() * 2];
        duplicate_rotated(&src, 4, 2, &mut dst);
        // Top row of the output is the source's bottom row read backwards.
        let top: Vec<u8> = (0..4).map(|i| px(&dst, i)).collect();
        assert_eq!(top, vec![8, 7, 6, 5]);
        let second: Vec<u8> = (4..8).map(|i| px(&dst, i)).collect();
        assert_eq!(second, vec![4, 3, 2, 1]);
    }

    #[test]
    fn in_place_agrees_with_the_two_buffer_version() {
        let src = frame();
        let mut want = vec![0; 32];
        duplicate_rotated(&src, 2, 2, &mut want);

        let mut live = src.clone();
        duplicate_rotated_in_place(&mut live, 2, 2);
        assert_eq!(live, want, "the same frame either way");
        assert_eq!(&live[16..], &src[..], "the original survives at the bottom");
    }

    #[test]
    fn in_place_keeps_a_wide_frame_intact() {
        let mut src = Vec::new();
        for i in 1u8..=8 {
            src.extend_from_slice(&[i, i, i, 255]);
        }
        let original = src.clone();
        let mut want = vec![0; original.len() * 2];
        duplicate_rotated(&original, 4, 2, &mut want);

        duplicate_rotated_in_place(&mut src, 4, 2);
        assert_eq!(src, want);
    }

    #[test]
    #[should_panic(expected = "duplicate_rotated_in_place: frame is")]
    fn in_place_refuses_a_wrong_sized_buffer() {
        let mut buf = vec![0u8; 31];
        duplicate_rotated_in_place(&mut buf, 2, 2);
    }

    #[test]
    #[should_panic(expected = "source is")]
    fn wrong_source_length_is_refused() {
        let mut dst = vec![0; 32];
        duplicate_rotated(&[0u8; 3], 2, 2, &mut dst);
    }

    #[test]
    #[should_panic(expected = "destination is")]
    fn wrong_destination_length_is_refused() {
        let mut dst = vec![0; 31];
        duplicate_rotated(&frame(), 2, 2, &mut dst);
    }
}
