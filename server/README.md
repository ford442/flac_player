# server/ — optional local dev backend

A single-file FastAPI app (`app.py`) that mirrors the subset of the Storage Manager API the
player uses (`/api/songs`, tags, plays, MusicBrainz lookup, ReplayGain, playlist sharing,
listening-room prototype). **Production is `contabo_storage_manager` on
https://storage.noahcohn.com**, not this directory — the frontend talks to the remote host by
default (`REACT_APP_API_URL`), so you only need this for offline development or for
prototyping API changes before porting them to the Storage Manager.

```bash
cd server
pip install -r requirements.txt
python app.py                      # http://localhost:7860, data in server/data/ (DATA_DIR)
python -m unittest tests.test_replaygain
```

To point the dev frontend at it, set `REACT_APP_API_URL=` (empty, uses the webpack `/api`
proxy → `localhost:7860`) or `REACT_APP_API_URL=http://localhost:7860`.
Env vars are documented in the root `.env.example`.
