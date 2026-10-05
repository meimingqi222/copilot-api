# Agent Note: Prefer TRAE agent model metadata on equal wire configurations

Status: implemented

## Problem

Trae returns separate model catalogs for chat_v3, solo_work_lite, solo_agent and solo_agent_lite. The same config_name can have different display names. Live inspection found chat_v3 naming deepseek-v4.1-flash as DeepSeek-V4-Flash 正式版 even though its dev model_name was deepseek-v4.1-flash\_\_dev. Discovery preferred a dev entry, but when both modes supplied dev entries it kept the first, so old chat_v3 names and limits could overwrite TRAE agent metadata. A second live query confirmed solo_work_lite, solo_agent and solo_agent_lite name the same ID DeepSeek-V4.1-Flash; all four modes contain dev entries. The screenshot uses that spelling too.

## Decision

Continue preferring usable dev entries. When entries have equal dev availability, prefer solo_agent, the TRAE agent mode. Name, limits and the preferred chat function come from the same selected entry. Keep deduplication by config_name and retain separate upstream IDs, including Official variants.

## Alternatives considered

- Hard-code a DeepSeek name correction: would mask one mismatch without fixing metadata selection for other models.
- Remove models sharing a display name: distinct upstream configurations can have the same name and must not be conflated.
- Return only one mode's catalog: would drop models available through other supported functions.

## Consequences

The combined catalog remains broader than a client's current-mode picker. An existing account needs model rediscovery after deployment to obtain revised names. An agent entry without a dev model cannot displace a usable dev entry from another mode. Genuine unknown upstream labels are preserved rather than guessed from model IDs.

## Verification

- `tests/trae-cn-models.test.ts::TRAE agent metadata wins when the same model has dev entries in multiple modes`
- `tests/trae-cn-models.test.ts::different upstream IDs remain separate even when their display names match`
- `tests/trae-cn-models.test.ts::a usable dev configuration still wins over TRAE agent entries without dev`

Proved: the pre-fix focused run failed the metadata assertion with name DeepSeek-V4-Flash 正式版 and output 16000 instead of DeepSeek-V4.1-Flash and output 64000; output is saved in `.agents/notes-evidence/trae-model-metadata-red.log`. After the priority fix, all 21 affected tests passed, including model discovery, authentication and native tool streaming.
