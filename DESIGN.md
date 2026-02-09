# Design

## Portals

Portals are where we interact with external data sources. E.g. browsing webpages, chatting with LLMs, reading documents.

There are three types of information embeded in an interaction:

- User Intent (search keywords, prompts)
- External Data
- User Attention (engagement pattern, highlights)

The system should keep records of user intent and attention to the finest details possible, and optionally archive external material based on its quality (e.g. +rarity, +uniqueness, -reproducibility).

In addition to being an external memory, the history of interactions (timeline and lineage) can be used to:
- reconstruct thought process or explore alternative reasoning paths.
- deduce cognitive preference or bias, valuable for information discovery.
- categorize information based on context (activity patterns, e.g. work, research), not content.

Some portals support lineage tracking natively (e.g. hyperlinks), for those that don't, we use temporal proximity as a heuristic, and potentially use SLMs to rate the confidence.

[It could be difficult to cover all platforms and apps. Needs at least (1) web browser integration, (2) importing text and extracting timestamps automatically, (3) PDF read and annotation.]

## Notes and Ideas

Notes and ideas are a special type of data that have no explicit intent or attention. Or rather, they are the intent/attention incarnated. They are recorded in the same timeline as portal interactions.

Compared to portals, there are special opportunities and challenges in tracking the lineage of notes and ideas.

Some portals have native support for tracking lineage (e.g. hyperlinks), 

## Use Only Search

The system intentionally avoids displaying information as graph. Graph carries an opinion (stronger that alternatives) that intrudes how user thinks. Graph with its branching is taxing on working memory and is notoriously hard to navigate.

Instead, the system chooses to display in sorted lists, like a good old search query. And search is the primary UI to get information. Compared to public searches, the private search has multiple ranking algorithms to choose from. That includes content, context, lineage, attention. User can mix all of them on a palette-like interface.

Each search queries can be pinned to become a materialized view, a topic. And user can selectively pin and save search results. User can also review or subscribe changes when a new information is added to system and matches the original query.

Categorization is a type of deterministic search that pins all results. System offers many such builtin searches.

