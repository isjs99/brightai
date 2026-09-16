Daily FastMoss pulls land here as `YYYY-MM-DD.json` (`{ "pulled_at": "...", "shops": [ ...shop_search rows, optionally with shop_created_date ] }`).
The server imports each new file once at startup and at 06:00, refreshing the numbers of shops it already tracks and adding new ones.
Status, owner, contacts and outreach history are never touched by an import.
