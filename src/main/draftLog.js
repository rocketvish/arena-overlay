/**
 * draftLog.js — saved drafts for the post-draft review.
 *
 * Each finished draft is written to userData/drafts/<iso-time>_<SET>.json with
 * every pick, what the assistant recommended at that moment, and the deck it
 * suggested at the end. Kept to the most recent MAX_DRAFTS files.
 */

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const MAX_DRAFTS = 50;

function dir() {
  return path.join(app.getPath('userData'), 'drafts');
}

function saveDraft(record) {
  if (!record?.picks?.length) return null;
  try {
    fs.mkdirSync(dir(), { recursive: true });
    const endedAt = new Date().toISOString();
    const set = /^[A-Z0-9]{2,8}$/.test(record.setCode ?? '') ? record.setCode : 'UNK';
    const file = `${endedAt.replace(/[:.]/g, '-')}_${set}.json`;
    fs.writeFileSync(path.join(dir(), file), JSON.stringify({ ...record, endedAt }), 'utf-8');
    // Prune oldest beyond the cap.
    const files = fs.readdirSync(dir()).filter((f) => f.endsWith('.json')).sort();
    for (const old of files.slice(0, Math.max(0, files.length - MAX_DRAFTS))) fs.unlinkSync(path.join(dir(), old));
    return file;
  } catch (e) {
    console.error('[draftLog] save failed:', e.message);
    return null;
  }
}

/** Newest first: [{ file, setCode, format, endedAt, picks, agreed }] */
function listDrafts() {
  try {
    if (!fs.existsSync(dir())) return [];
    return fs.readdirSync(dir()).filter((f) => f.endsWith('.json')).sort().reverse().map((file) => {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(dir(), file), 'utf-8'));
        const withRec = d.picks.filter((p) => p.recommendedGrpId != null);
        return {
          file, setCode: d.setCode, format: d.format, endedAt: d.endedAt,
          picks: d.picks.length,
          agreed: withRec.length ? withRec.filter((p) => p.alignedWithRec).length / withRec.length : null,
          deckColors: d.deck?.colors ?? null,
        };
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function getDraft(file) {
  // Only plain file names from listDrafts() — never a path.
  if (typeof file !== 'string' || !/^[\w-]+_[A-Z0-9]{2,8}\.json$/.test(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(dir(), file), 'utf-8'));
  } catch {
    return null;
  }
}

module.exports = { saveDraft, listDrafts, getDraft };
