import random

ideas = [
    {
        "title": "The Tuvan Trap Lord",
        "service": "Minimax Audio",
        "prompt": "A heavy, dark modern Trap hip-hop beat featuring frantic triplet hi-hats and deep 808 sub-basses. The entire melodic and atmospheric backing is completely composed of the deep, rumbling Kargyraa sub-harmonics and piercing Sygyt whistling overtones of a Tuvan throat singer, perfectly mimicking the dark minor-key trap synths and ad-libbing rhythmically.",
        "lyrics": """(Verse 1 - Deep, rumbling Kargyraa throat singing acting as a rhythmic rap flow)
(Bass drops a low 808 note matching the throat singing pitch)
Rolling through the steppe, riding on the yak...
(Sygyt overtone whistle hits a high, sustained harmony over the trap hi-hats)
Sipping fermented mare's milk, no looking back!
(Kargyraa ad-libs: "Skrrt, skrrt!")

(Chorus)
(Massive 808 drop with a perfectly tuned, overtonal throat singing swell)
Trap in the yurt! The harmonics are tight!
We're singing on the tundra in the middle of the night!
Ice on the saddle, fur coats on the grind!
Leaving the regular synth leads behind!""",
        "notes": "- **Combo/Fusion:** Modern Trap / Tuvan Throat Singing\n- **Thematic Ties:** The gritty, bass-heavy, street-oriented sound of modern Trap colliding with the deeply resonant, earthy, and ancient vocal techniques of Mongolian nomads."
    },
    {
        "title": "Shamisen Surf's Up",
        "service": "Minimax Audio",
        "prompt": "A high-energy, reverb-drenched 1960s Surf Rock instrumental tune with a driving, frantic drum beat. The classic, twangy Fender Stratocaster electric guitar leads and rapid-fire tremolo picking are entirely replaced by a lightning-fast Japanese Shamisen, drenched in massive spring reverb and delay, while the explosive drum fills are performed on massive, booming Taiko drums.",
        "lyrics": """(Verse 1 - No human vocals, just instrumental surf rock energy)
(Massive Taiko drum fill mimicking a classic surf rock intro)
(Shamisen drops into a twangy, fast-paced, reverb-heavy surf melody)
(Upright bass walks a rapid, driving line)

(Chorus)
(The ensemble locks into a frantic, high-speed groove)
(Shamisen executes a blazing tremolo-picked solo)
(Taiko drums crash like breaking ocean waves)""",
        "notes": "- **Combo/Fusion:** 1960s Surf Rock / Japanese Shamisen & Taiko\n- **Thematic Ties:** The sunny, beach-party energy and reverb-heavy electric twang of California surf rock completely reimagined through the percussive, aggressive, and culturally distinct timbre of traditional Japanese instruments."
    },
    {
        "title": "Baroque Beatdown",
        "service": "Minimax Audio",
        "prompt": "A punishing, slow-paced Deathcore track featuring guttural pig squeals, impossibly heavy down-tuned guitars, and frantic blast beats. However, the sludgy, oppressive doom riffs are completely overtaken by a ridiculously fast, elegant 18th-century Harpsichord and a delicate Viola da Gamba playing incredibly complex Bach-style counterpoint and fugues over the brutal metal breakdown.",
        "lyrics": """(Verse 1 - Guttural Deathcore pig squeals)
THE CONCERTO IS ROTTEN! THE MAESTRO IS DEAD!
(Harpsichord plucks a lightning-fast, highly ornamented baroque fugue)
THE ARISTOCRAT AWAKENS WITH A SEVERED HEAD!
(Viola da Gamba bows furiously alongside the blast beats)

(Chorus)
(Sludgy breakdown accompanied by a complex harpsichord solo)
DOOM IN THE PALACE! THE SYMPHONY OF HELL!
THE DARKEST LITTLE HARPSICHORD THAT EVER RANG THE BELL!
MOSHPITTING IN THE BALLROOM, KICKING UP THE DIRT!
THE HARPSICHORD PLAYER WEARS A HEAVY METAL SHIRT!""",
        "notes": "- **Combo/Fusion:** Brutal Deathcore / 18th-Century Baroque Harpsichord\n- **Thematic Ties:** The terrifying, aggressive, and brutal nature of Deathcore completely undercut and confused by the inherently elegant, highly structured, and aristocratic energy of a traditional baroque ensemble."
    },
    {
        "title": "Bossa Nova Blast Beats",
        "service": "Minimax Audio",
        "prompt": "A gentle, swaying Brazilian Bossa Nova track featuring complex, jazzy nylon-string guitar chords. The typically smooth, whispered Portuguese vocals are present, but the light, brushed snare drums are entirely replaced by incredibly fast, relentless Death Metal blast beats on a double-kick drum and aggressively smashed crash cymbals, completely ignoring the relaxed tropical tempo.",
        "lyrics": """(Verse 1 - Soft, breathy Bossa Nova vocal in Portuguese)
(Nylon-string guitar plays a beautiful, extended jazz chord)
(Suddenly, a deafening blast beat erupts on a double-kick pedal, completely burying the delicate guitar)
The sun sets softly on the gentle sea...

(Chorus)
(The blast beats continue relentlessly at 220 BPM)
Bossa of the blast beats, swaying in the breeze!
The loudest little drummer that you'd ever please!
Caipirinhas on the beach, double kicks on the floor!
Leaving you always wanting some more.""",
        "notes": "- **Combo/Fusion:** Brazilian Bossa Nova / Death Metal Blast Beats\n- **Thematic Ties:** The ultimate beachside relaxation and soft, breezy romance of Bossa Nova violently interrupted by the deafening, continuous, and aggressively fast drumming of a traditional death metal track."
    }
]

output = ""
for idea in ideas:
    output += f"\n### Title: {idea['title']}\n\n"
    output += f"**Service:** {idea['service']}\n\n"
    output += f"**Prompt:** {idea['prompt']}\n\n"
    output += f"**Lyrics:**\n{idea['lyrics']}\n\n"
    output += f"**Additional Notes:**\n{idea['notes']}\n"

print(output)
