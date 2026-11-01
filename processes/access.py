"""Access control for demo mode: a token for simulations.

It is active only if ``SIMULATION_TOKEN`` is set in the environment; otherwise every
function lets everything through and the app behaves as without it. With the token
active:

- running OpenDrift (precompute, opendrift, pmar without a scenario) needs the token;
- without the token, only the scenarios in ``PUBLIC_SCENARIOS`` (comma-separated ids)
  can be seen and analysed; if the list is empty, all of them.

The token travels in the inputs as ``access_token`` and is removed from *data* when it
is first read, so it does not go on to the logs, Celery or OpenDrift.
"""

import hmac
import os

from pygeoapi.process.base import ProcessorExecuteError

# A code, not a sentence: the frontend translates it into the user's language.
ACCESS_DENIED = 'ACCESS_DENIED'


def token_configured():
    """True if demo mode is active, that is, if ``SIMULATION_TOKEN`` is set."""
    return bool(os.environ.get('SIMULATION_TOKEN', '').strip())


def is_unlocked(data):
    """Remove ``access_token`` from *data* and tell whether it gives full access.

    Without demo mode, access is always full. The comparison takes constant time.
    Call it once per request: afterwards the token is no longer in *data*.
    """
    supplied = str(data.pop('access_token', None) or '')
    if not token_configured():
        return True
    expected = os.environ['SIMULATION_TOKEN'].strip()
    return hmac.compare_digest(supplied.encode(), expected.encode())


def require_unlocked(unlocked):
    """Raise ``ACCESS_DENIED`` if access is not full."""
    if not unlocked:
        raise ProcessorExecuteError(ACCESS_DENIED)


def public_scenarios():
    """Set of the ids in ``PUBLIC_SCENARIOS``; empty means no restriction."""
    raw = os.environ.get('PUBLIC_SCENARIOS', '')
    return {s.strip() for s in raw.split(',') if s.strip()}


def scenario_allowed(scenario_id, unlocked):
    """True if the scenario can be seen and analysed with this level of access."""
    if unlocked:
        return True
    allowed = public_scenarios()
    return not allowed or scenario_id in allowed


def require_scenario(scenario_id, unlocked):
    """Raise ``ACCESS_DENIED`` if the scenario is not accessible."""
    if not scenario_allowed(scenario_id, unlocked):
        raise ProcessorExecuteError(ACCESS_DENIED)
