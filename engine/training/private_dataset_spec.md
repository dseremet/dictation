# Private medical dataset — specification

The private set is what makes the model *medical*: real dictations in the
target register (anamneza, status, dijagnoza, terapija) with Latin
terminology, drug names, doses and spoken commands. It never leaves the
owner's infrastructure and is not part of this repository.

## Layout

```
private/
  metadata.jsonl
  audio/
    0001.wav  0002.wav ...         # or .flac / .m4a / .webm; any rate, mono preferred
```

One JSON object per line in `metadata.jsonl`:

| field | type | required | notes |
|---|---|---|---|
| `audio` | string | yes | path relative to `private/` |
| `text` | string | yes | target transcript, see conventions below |
| `language` | `bs`\|`hr`\|`sr` | yes | the doctor's language, not the clinic's |
| `domain` | string | no | `medical` (default), or a speciality: `cardio`, `derm`, `gyn`, `ortho`, `dental` ... |
| `speaker` | string | no | opaque pseudonymous id (`spk_017`), needed for speaker-disjoint dev split |
| `duration` | number | no | seconds; filled in by `prepare_data.py` when missing |
| `device` | string | no | `desktop-chrome`, `ios-app`, `android-app` |
| `source` | string | no | `dictation` (live, from the app) or `corrected` (doctor-corrected transcript) |

## Transcription conventions (what the model should learn to produce)

* Written clinical form, as a doctor would type it: digits for measurements
  (`TA 120/80`, `38,5 °C`, `500 mg`), units as symbols, common abbreviations
  (`EKG`, `CRP`, `p.o.`, `tbl.`) — i.e. the *output* of the normaliser, so
  the model and the normaliser agree.
* Casing and punctuation as in a finished note; sentence case, Latin terms
  with their usual spelling (`Helicobacter pylori`, `ulcus ventriculi`).
* **Dialect untouched**: write exactly what was said (`lijek`/`lek`,
  `tlak`/`pritisak`, `tjedan`/`sedmica`). Never "correct" ijekavica to
  ekavica or vice versa.
* Spoken commands are *executed*, not transcribed: "nova linija" becomes a
  line break, "tačka" a period. If a doctor said "bolna tačka", that stays.
* Fillers (`ovaj`, `hm`) and false starts are dropped; everything medical is
  kept verbatim, including hedges ("vjerovatno", "suspektno").
* Latin script only; Cyrillic recordings get Latin targets.
* One utterance ≤ 30 s. Split longer dictations on pauses; keep the split
  points out of the middle of a number or drug name.

## De-identification and consent

* Patient names, dates of birth, addresses, ID numbers, phone numbers: cut
  the audio (silence) and write `[ime]` / `[datum]` in the target; such rows
  are kept only if the remaining text is still ≥ 3 words.
* Doctor consent for use in model training is recorded per speaker; the
  `speaker` id maps to the consent record outside this dataset.
* Store the set encrypted at rest; `prepare_data.py` reads it locally and the
  resulting manifests must stay out of git (`engine/data/` is ignored).

## Minimum useful size

* 20 h gives a measurable gain on medical-term recall; 50 h with ≥ 30
  speakers across bs/hr/sr and the main specialities is the v1 target.
* Keep 5 % of speakers (not utterances) as the private dev/test set; that is
  what `eval/run_private.py` reports on.

## Quality checks before training

`prepare_data.py` drops rows that fail `normalize_targets.is_acceptable`:
empty text, < 0.3 s or > 35 s, or an implausible characters-per-second rate
(< 2 or > 30), which almost always means a misaligned transcript.
