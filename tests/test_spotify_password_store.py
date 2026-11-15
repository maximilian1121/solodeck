"""Verify the saved session is authenticated ciphertext, not a plaintext cookie."""
import json
import os
import stat
import tempfile
import unittest
from pathlib import Path

from spotify_password_store import PasswordSessionStore, SessionStoreError


class PasswordSessionStoreTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "session.enc"
        self.store = PasswordSessionStore(self.path)
        self.cookie = "sp_dc=secret-session-value"
        self.password = "a memorable test password"

    def test_round_trip_permissions_and_removal(self):
        self.store.save(self.cookie, self.password)
        blob = self.path.read_bytes()
        self.assertNotIn(self.cookie.encode(), blob)
        self.assertNotIn(self.password.encode(), blob)
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)
        self.assertEqual(self.store.unlock(self.password), self.cookie)
        self.store.clear()
        self.assertFalse(self.store.exists())

    def test_wrong_password_and_modified_ciphertext_fail(self):
        self.store.save(self.cookie, self.password)
        with self.assertRaises(SessionStoreError):
            self.store.unlock("wrong password")
        data = json.loads(self.path.read_bytes())
        data["ciphertext"] = ("A" if data["ciphertext"][0] != "A" else "B") + data["ciphertext"][1:]
        self.path.write_text(json.dumps(data))
        with self.assertRaises(SessionStoreError):
            self.store.unlock(self.password)

    def test_new_salt_and_nonce_for_every_save(self):
        self.store.save(self.cookie, self.password)
        first = json.loads(self.path.read_bytes())
        self.store.save(self.cookie, self.password)
        second = json.loads(self.path.read_bytes())
        self.assertNotEqual(first["salt"], second["salt"])
        self.assertNotEqual(first["nonce"], second["nonce"])
        self.assertEqual(self.store.unlock(self.password), self.cookie)

    def test_invalid_input_does_not_write_a_session(self):
        with self.assertRaises(SessionStoreError):
            self.store.save(self.cookie, "")
        with self.assertRaises(SessionStoreError):
            self.store.save("not-a-cookie", self.password)
        self.assertFalse(self.store.exists())


if __name__ == "__main__":
    unittest.main()
