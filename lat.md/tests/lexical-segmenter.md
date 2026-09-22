---
lat:
  require-code-mention: true
---

# Lexical Segmenter

Tests verify CJK word segmentation and the project glossary that extends the segmenter's dictionary.

## CJK Segmentation

Lexical analysis segments a Han run into words, because a character run between punctuation marks is otherwise a single token that no query can match.

### Splits a Han run into words

A Han run is segmented into the words the dictionary knows, and the run itself is not kept as a token — a whole-clause token would defeat the precision the segmentation exists to provide.

### Leaves non-Han runs to the stemmer

Latin runs bypass the segmenter entirely and still go through Snowball stemming, and kana or hangul runs stay whole rather than being split by a dictionary that has no vocabulary for them.

### Loads the segmenter only for Han text

The segmenter module is imported dynamically and only when tokenized text actually contains Han, so a project without Han content never pays for its dictionary.

Tokenization is synchronous, so Han text the glossary does not cover fails loudly rather than emitting the whole-clause token that segmentation exists to eliminate.

## Project Glossary

A project can name terms the dictionary does not know, because a term that is split into its parts turns an exact-term search into a fuzzy one.

### Keeps a listed word whole

A listed compound word is returned as one token instead of being split, and the rest of the run is still segmented rather than being swallowed by the match.

### Folds case before matching

Entries are lower-cased before matching, because tokenization lower-cases its input — an entry kept in its original case would validate and then silently never match.

### Never splits a non-Han run

The glossary is consulted only for runs containing Han, so an entry cannot break apart a Latin word that already tokenizes correctly as one token.

### Replaces the glossary rather than accumulating

Adopting a glossary discards the previous one, so a long-lived process that serves one project cannot answer for another with the wrong dictionary.

### Folds the glossary into the lexical version

The glossary participates in the lexical version in sorted order, so changing it re-tokenizes the index while reordering it does not.

### Reads the glossary from the project config

The config accepts an array of words, each of which must be a single token of letters, digits, or underscores containing a Han character — anything else could never match one and would be a silent no-op, so it is rejected instead.

## Chinese Retrieval

End-to-end retrieval over Chinese passages, where the lexical channel previously could not match any term shorter than a whole punctuation-delimited clause.

### Finds a term inside a longer clause

A term that appears only inside a longer Chinese clause is found by the lexical channel, which is the case that segmentation exists to fix.

### Adopts the glossary the index recorded

The query side tokenizes with the glossary recorded in the index rather than the current config, so a config edit that has not been re-indexed cannot split the query differently from the passages it searches.

### Re-tokenizes when the config glossary changes

Editing the config's glossary re-tokenizes existing rows, because the version tag is the only thing that tells the index its rows came from other rules. Re-indexing an unchanged project reuses them.

### Validates the version against the recorded glossary

A reader rejects an index whose version disagrees with the glossary the index itself records, so stale rows fail loudly instead of silently matching tokens they were never indexed under.
