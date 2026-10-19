# Glossary

YAML files merged at start-up (`ASR_GLOSSARY_DIR`). The merged content drives
two things: Whisper **hotwords** (terms with `prompt: true`, by `weight`) and
the **normaliser** (variants -> canonical, abbreviations, units, commands,
hallucination filter).

```
shared/latin_medical.yaml   terms: diagnoses, anatomy, procedures, findings
shared/drugs.yaml           terms: generic drug names used in BiH/HR/RS
shared/abbreviations.yaml   abbreviations with context gates
shared/units.yaml           spoken units -> symbols
bs|hr|sr/commands.yaml      spoken punctuation and layout commands
bs|hr|sr/terms.yaml         dialect words listed as self-mapping (never rewritten)
bs|hr|sr/hallucinations.yaml phrases Whisper invents on silence/music
```

## Shapes

```yaml
terms:
  - canonical: hipertenzija          # what the doctor wants to read
    variants: [hiper tenzija, hypertenzija]   # what Whisper produced
    weight: 2                        # hotword priority (default 1)
    prompt: true                     # eligible for hotwords (default true)
    category: dg                     # free text: dg | anat | proc | drug | lab | ...

abbreviations:
  - canonical: TA
    variants: [te a, ta]
    context: before_number           # always | before_number | after_number | line_start_or_colon
    or_words: [uredna, povišena]     # before_number also accepts these right-context words

units:
  - symbol: mg
    phrases: [miligrama, miligram, miligrame]
    attach: space                    # space "5 mg" | glue "5%" | suffix "ml/h"

commands:
  - output: "."
    phrases: [tačka]
    attach: left                     # left | right | newline | none
    not_after: [bolna, pritisna]     # "bolna tačka" is anatomy, not punctuation

hallucinations:
  - Hvala na gledanju
```

Rules of thumb:

* Variants are matched as whole words, case-insensitively, longest first.
  List inflected forms explicitly (`hipertenzije`, `hipertenziju`) when they
  are commonly misrecognised.
* Never map an ijekavica form to an ekavica one or vice versa (`lijek`/`lek`,
  `mjesec`/`mesec`). The per-language `terms.yaml` files list them as
  self-mapping canonicals so the dictionary cannot flip a dialect; a test
  asserts both survive the normaliser.
* The per-request `glossary` field of the API takes the same `terms` shape
  and is merged in front of these files for that request only.
* Keep entries ASCII-clean where the canonical spelling is Latin (`ulcus
  ventriculi`), and with diacritics where it is BHS (`žučna kesa`).
