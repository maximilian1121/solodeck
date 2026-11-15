"""Password-protected Spotify session storage; the password is never stored."""
from __future__ import annotations

import base64
import binascii
import hashlib
import json
import os
import tempfile
from pathlib import Path

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM


class SessionStoreError(Exception):
    """A session could not be saved, unlocked, or removed."""


class PasswordSessionStore:
    """Store a session as authenticated ciphertext protected by a user password."""

    _AAD = b"solodeck:spotify-session:v1"
    _MAX_FILE_BYTES = 65536

    def __init__(self, path: str | os.PathLike[str]):
        self.path = Path(path)

    @staticmethod
    def _key(password: str, salt: bytes) -> bytes:
        if not isinstance(password, str) or not password:
            raise SessionStoreError("Enter your session password.")
        try:
            encoded = password.encode("utf-8")
            return hashlib.scrypt(encoded, salt=salt, n=32768, r=8, p=1,
                                  dklen=32, maxmem=128 * 1024 * 1024)
        except (UnicodeError, ValueError, MemoryError) as error:
            raise SessionStoreError("Could not process the session password.") from error

    @staticmethod
    def _valid_cookie(cookie: str) -> bool:
        return (isinstance(cookie, str) and cookie.startswith("sp_dc=")
                and len(cookie) > 6 and not any(c in cookie for c in "\r\n;"))

    def exists(self) -> bool:
        return self.path.is_file()

    def save(self, cookie: str, password: str) -> None:
        if not self._valid_cookie(cookie):
            raise SessionStoreError("Invalid Spotify session.")
        salt, nonce = os.urandom(16), os.urandom(12)
        key = self._key(password, salt)
        ciphertext = AESGCM(key).encrypt(nonce, cookie.encode("utf-8"), self._AAD)
        blob = json.dumps({
            "version": 1,
            "salt": base64.b64encode(salt).decode("ascii"),
            "nonce": base64.b64encode(nonce).decode("ascii"),
            "ciphertext": base64.b64encode(ciphertext).decode("ascii"),
        }, separators=(",", ":")).encode("ascii")
        temp_name = None
        try:
            self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            fd, temp_name = tempfile.mkstemp(prefix=".spotify-session-", dir=self.path.parent)
            with os.fdopen(fd, "wb") as out:
                os.fchmod(out.fileno(), 0o600)
                out.write(blob)
                out.flush()
                os.fsync(out.fileno())
            os.replace(temp_name, self.path)
            temp_name = None
        except OSError as error:
            raise SessionStoreError("Could not save the encrypted Spotify session.") from error
        finally:
            if temp_name is not None:
                try:
                    os.unlink(temp_name)
                except OSError:
                    pass

    def unlock(self, password: str) -> str:
        try:
            with self.path.open("rb") as source:
                raw = source.read(self._MAX_FILE_BYTES + 1)
            if len(raw) > self._MAX_FILE_BYTES:
                raise ValueError("Invalid session data")
            envelope = json.loads(raw)
            if not isinstance(envelope, dict) or envelope.get("version") != 1:
                raise ValueError("Invalid session data")
            salt = base64.b64decode(envelope["salt"], validate=True)
            nonce = base64.b64decode(envelope["nonce"], validate=True)
            ciphertext = base64.b64decode(envelope["ciphertext"], validate=True)
            if len(salt) != 16 or len(nonce) != 12 or len(ciphertext) < 17:
                raise ValueError("Invalid session data")
            key = self._key(password, salt)
            result = AESGCM(key).decrypt(nonce, ciphertext, self._AAD).decode("utf-8")
            if not self._valid_cookie(result):
                raise ValueError("Invalid session data")
            return result
        except (OSError, ValueError, KeyError, TypeError, UnicodeError, binascii.Error, InvalidTag) as error:
            raise SessionStoreError("Incorrect password or invalid saved Spotify session.") from error

    def clear(self) -> None:
        try:
            self.path.unlink(missing_ok=True)
        except OSError as error:
            raise SessionStoreError("Could not remove the saved Spotify session.") from error
