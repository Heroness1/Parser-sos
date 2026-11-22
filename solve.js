// Parser-sos: a faster drop-in for csv-reader 1.0.0 (make.fun).
//
// The reference (csv-reader 1.0.0, vendor/csv-reader) reads one character at a
// time and builds every field a character at a time. This module returns
// exactly the same {columns, rows, errors} for every {text, header} input,
// but scans with indexOf and slices fields out, so the common case never
// touches a character at a time:
//
//   - a line with no quote and no stray CR is cut into fields with an
//     indexOf(',') loop, sliced straight from the text;
//   - an unquoted field is found with indexOf(',') / indexOf('\n'), and a
//     stray CR inside it is dropped exactly as the reference drops it;
//   - a quoted field is found with indexOf('"'); doubled quotes and CR/LF
//     inside quotes are handled exactly as the reference handles them.
//
// The hot paths are inlined in the record loop (no call, no shared result
// object) and fall back to the shared readers for the rare cases: a stray
// CR in an unquoted field, a doubled quote, a CR inside quotes, an
// unterminated quote, or junk after a closing quote.
//
// Where the reference's behaviour is subtle, this code mirrors it line for
// line (see the comments): a BOM is dropped, empty lines are no records, a
// line of only stray CRs is no record (its stray_cr errors stay), a quote
// that never closes is a literal character and the text after it is read
// again as unquoted, what follows a closing quote is appended as it stands,
// and every error carries the line its record starts on.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** Count '\n' in s. One indexOf call when there is none. */
function countLF(s) {
  let n = 0;
  let p = 0;
  for (;;) {
    p = s.indexOf('\n', p);
    if (p === -1) return n;
    n++;
    p++;
  }
}

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  let pos = 0;
  let line = 1;
  if (len > 0 && text.charCodeAt(0) === 0xFEFF) pos = 1;

  // The record being read: the line it starts on and the index in rows it
  // takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // The field being read, shared by the readers below. Each call overwrites
  // it and its caller reads it at once, so no call overlaps another.
  const F = { value: '', ended: END, added: 0 };

  function strayCR() {
    errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
  }

  // Read an unquoted field starting at pos, with `prefix` already in its
  // value ('' at a field start, '"' after an unterminated quote, the quoted
  // value for quote junk). Returns F {value, ended, added}: `added` counts
  // the characters this call appended (the prefix does not count).
  //
  // The field ends at the first ',' or line break at or after pos. A CR
  // inside that span is a stray CR unless it is the CR of the CRLF that ends
  // the field: each stray CR is dropped with one stray_cr error, and the
  // field still ends where the ',' or line break is.
  function readUnquoted(prefix) {
    const iC = text.indexOf(',', pos);
    const iN = text.indexOf('\n', pos);
    let end;
    let ended;
    if (iC === -1 && iN === -1) {
      end = len;
      ended = END;
    } else if (iN === -1 || (iC !== -1 && iC < iN)) {
      end = iC;
      ended = COMMA;
    } else {
      end = iN;
      ended = LINE_BREAK;
    }
    let piece = text.slice(pos, end);
    if (ended === LINE_BREAK && piece.charCodeAt(piece.length - 1) === 13) {
      // CRLF: this CR is the line break's, not a stray one.
      piece = piece.slice(0, -1);
    }
    let added;
    const r = piece.indexOf('\r');
    if (r !== -1) {
      let cleaned = '';
      let from = 0;
      for (let i = r; i < piece.length; i++) {
        if (piece.charCodeAt(i) === 13) {
          strayCR();
          cleaned += piece.slice(from, i);
          from = i + 1;
        }
      }
      cleaned += piece.slice(from);
      added = cleaned.length;
      piece = cleaned;
    } else {
      added = piece.length;
    }
    if (ended === COMMA) {
      pos = end + 1;
    } else if (ended === LINE_BREAK) {
      pos = end + 1;
      line++;
    } else {
      pos = len;
    }
    F.value = prefix === '' ? piece : prefix + piece;
    F.ended = ended;
    F.added = added;
    return F;
  }

  // Read a quoted field whose opening quote is at pos. Returns F.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    pos++;
    let piece0 = '';
    let pieces = null;
    let hasPiece = false;
    let closed = false;
    while (pos < len) {
      const q = text.indexOf('"', pos);
      if (q === -1) break;
      let seg = text.slice(pos, q);
      if (seg.indexOf('\r') === -1) {
        line += countLF(seg);
      } else {
        // CRLF and a lone CR inside quotes are each one LF.
        seg = seg.replace(/\r\n?/g, '\n');
        line += countLF(seg);
      }
      if (text.charCodeAt(q + 1) === 34) {
        // A doubled quote is one quote in the value.
        if (!hasPiece) {
          piece0 = seg;
          hasPiece = true;
          pieces = [piece0, '"'];
        } else if (pieces === null) {
          pieces = [piece0, seg, '"'];
        } else {
          pieces.push(seg, '"');
        }
        pos = q + 2;
        continue;
      }
      if (!hasPiece) {
        piece0 = seg;
        hasPiece = true;
      } else if (pieces === null) {
        pieces = [piece0, seg];
      } else {
        pieces.push(seg);
      }
      pos = q + 1;
      closed = true;
      break;
    }
    if (!closed) {
      // The quote never closes: it is a literal character, and the text
      // after it is read again as unquoted.
      pos = open + 1;
      line = openLine;
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      return readUnquoted('"');
    }
    const value = pieces === null ? piece0 : pieces.join('');
    if (pos >= len) {
      F.value = value;
      F.ended = END;
      F.added = 0;
      return F;
    }
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos++;
      F.value = value;
      F.ended = COMMA;
      F.added = 0;
      return F;
    }
    if (c === 10) {
      pos++;
      line++;
      F.value = value;
      F.ended = LINE_BREAK;
      F.added = 0;
      return F;
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line++;
      F.value = value;
      F.ended = LINE_BREAK;
      F.added = 0;
      return F;
    }
    // What follows the closing quote is appended as it stands, up to the
    // next comma or line break.
    const junk = readUnquoted(value);
    if (junk.added > 0) {
      errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    }
    return junk;
  }

  // Finish a record's fields: a line that held only stray CRs is no record;
  // the first record sets the width (and the header, when header is true);
  // later records are padded (short_row) or cut (long_row) to it.
  // Returns false when the record is skipped.
  function finalize(fields, lastQuoted) {
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) return false;
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return true;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
    return true;
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos++;
        line++;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line++;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Fast path: a line with no quote. A CR in it is allowed only as the
    // CR of its CRLF line break; any other CR takes the slow path.
    const lineEnd = text.indexOf('\n', pos);
    const hasNL = lineEnd !== -1;
    const end = hasNL ? lineEnd : len;
    const lineStr = text.slice(pos, end);
    if (lineStr.indexOf('"') === -1) {
      const rIdx = lineStr.indexOf('\r');
      if (rIdx === -1) {
        // v2b trial: manual field loop over the line slice instead of split(',').
        const fields = [];
        let f = 0;
        for (;;) {
          const c = lineStr.indexOf(',', f);
          if (c === -1) { fields.push(lineStr.slice(f)); break; }
          fields.push(lineStr.slice(f, c));
          f = c + 1;
        }
        if (hasNL) {
          pos = end + 1;
          line++;
        } else {
          pos = len;
        }
        finalize(fields, false);
        continue;
      }
      if (hasNL && rIdx === lineStr.length - 1) {
        const ls = lineStr.slice(0, -1);
        const fields = [];
        let f = 0;
        for (;;) {
          const c = ls.indexOf(',', f);
          if (c === -1) { fields.push(ls.slice(f)); break; }
          fields.push(ls.slice(f, c));
          f = c + 1;
        }
        pos = end + 1;
        line++;
        finalize(fields, false);
        continue;
      }
      // A stray CR inside the line: fall through to the slow path.
    }

    // Slow path: field by field. The unquoted case is inlined here (no
    // call, no shared result object); a stray CR inside it falls back to
    // readUnquoted, which handles the cleaning.
    const fields = [];
    let lastQuoted = false;
    let ended;
    do {
      if (text.charCodeAt(pos) === 34) {
        lastQuoted = true;
        // Inline the common quoted field: one segment, no doubled quote,
        // no CR inside, closed and followed by ',', a line break, or the
        // end. Anything else (doubled quote, CR inside, unterminated,
        // junk after the close) falls back to readQuoted with line and
        // pos untouched.
        const q = text.indexOf('"', pos + 1);
        let handled = false;
        if (q !== -1 && text.charCodeAt(q + 1) !== 34) {
          const seg = text.slice(pos + 1, q);
          if (seg.indexOf('\r') === -1) {
            if (q + 1 >= len) {
              line += countLF(seg);
              pos = len;
              fields.push(seg);
              ended = END;
              handled = true;
            } else {
              const c = text.charCodeAt(q + 1);
              if (c === 44) {
                line += countLF(seg);
                pos = q + 2;
                fields.push(seg);
                ended = COMMA;
                handled = true;
              } else if (c === 10) {
                line += countLF(seg);
                pos = q + 2;
                line++;
                fields.push(seg);
                ended = LINE_BREAK;
                handled = true;
              } else if (c === 13 && text.charCodeAt(q + 2) === 10) {
                line += countLF(seg);
                pos = q + 3;
                line++;
                fields.push(seg);
                ended = LINE_BREAK;
                handled = true;
              }
            }
          }
        }
        if (!handled) {
          const f = readQuoted();
          fields.push(f.value);
          ended = f.ended;
        }
      } else {
        lastQuoted = false;
        const iC = text.indexOf(',', pos);
        const iN = text.indexOf('\n', pos);
        let end;
        if (iC === -1 && iN === -1) {
          end = len;
          ended = END;
        } else if (iN === -1 || (iC !== -1 && iC < iN)) {
          end = iC;
          ended = COMMA;
        } else {
          end = iN;
          ended = LINE_BREAK;
        }
        let piece = text.slice(pos, end);
        if (ended === LINE_BREAK && piece.charCodeAt(piece.length - 1) === 13) {
          piece = piece.slice(0, -1);
        }
        if (piece.indexOf('\r') !== -1) {
          const f = readUnquoted('');
          fields.push(f.value);
          ended = f.ended;
        } else {
          if (ended === COMMA) {
            pos = end + 1;
          } else if (ended === LINE_BREAK) {
            pos = end + 1;
            line++;
          } else {
            pos = len;
          }
          fields.push(piece);
        }
      }
    } while (ended === COMMA);
    finalize(fields, lastQuoted);
  }

  return { columns: header ? (columns ?? []) : null, rows, errors };
}
