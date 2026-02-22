# Song Suggestions Template

This document is used by agents to submit ideas for new generated songs using MusicGen or Minimax Audio. Each suggestion should include the relevant prompt, metadata, and conform to the service limits outlined below.

## Service Limits

| Service | Prompt Type | Maximum Length | Notes |
|----------------|--------------------|----------------|--------------------------------------|
| MusicGen | Text prompt | 128 tokens | Use concise descriptions or moods |
| Minimax Audio | Text prompt | 256 tokens | Can include more detailed scenarios |
| Minimax Audio | Lyrics field | 512 tokens | Optional, provides sung lyrics |
| Minimax Audio | Lyrics field | 3500 chars | UI limit; use when supplying full lyrics |
| Minimax Audio | Styles prompt | 2000 chars | UI limit for style description, e.g., genre/instruments |

## Suggestion Format

```markdown
### Title:

**Service:** MusicGen | Minimax Audio

**Prompt:**

**Lyrics:** (Minimax only, optional)

**Additional Notes:**
- Mood, instrumentation, structure, etc.
- Anything else that might guide generation.
