# Normaliser cases

Table-driven: every `*.yaml` here is a list of cases run by
`tests/unit/test_normalizer_cases.py` through the full pipeline.

```yaml
- name: blood pressure
  language: bs            # bs | hr | sr (default bs)
  input: "pritisak sto dvadeset sa osamdeset tačka"
  expected: "Pritisak 120/80."
  glossary:               # optional per-request terms, same shape as the API field
    - { canonical: Botox, variants: [botoks] }
```
