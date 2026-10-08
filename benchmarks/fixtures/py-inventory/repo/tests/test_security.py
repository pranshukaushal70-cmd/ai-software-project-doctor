from app.security import file_digest, session_token


def test_file_digest_is_stable():
    assert file_digest(b"abc") == file_digest(b"abc")


def test_session_tokens_differ():
    assert session_token() != session_token()
