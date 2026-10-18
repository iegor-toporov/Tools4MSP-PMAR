"""Controllo d'accesso per la modalità demo: un token per le simulazioni.

Si attiva solo se ``SIMULATION_TOKEN`` è impostato nell'ambiente; altrimenti ogni
funzione lascia passare tutto e l'app si comporta come prima. Con il token attivo:

- far girare OpenDrift (precompute, opendrift, pmar senza scenario) richiede il token;
- senza token sono visibili e analizzabili solo gli scenari in ``PUBLIC_SCENARIOS``
  (id separati da virgole); se la lista è vuota, tutti.

Il token viaggia negli input come ``access_token`` e viene tolto da *data* alla prima
lettura, così non prosegue verso log, Celery o OpenDrift.
"""

import hmac
import os

from pygeoapi.process.base import ProcessorExecuteError

# Codice, non frase: il frontend lo traduce nella lingua dell'utente.
ACCESS_DENIED = 'ACCESS_DENIED'


def token_configured():
    """True se la modalità demo è attiva, cioè se ``SIMULATION_TOKEN`` è impostato."""
    return bool(os.environ.get('SIMULATION_TOKEN', '').strip())


def is_unlocked(data):
    """Toglie ``access_token`` da *data* e dice se dà accesso pieno.

    Senza modalità demo l'accesso è sempre pieno. Il confronto è a tempo costante.
    Va chiamata una volta sola per richiesta: dopo, il token non è più in *data*.
    """
    supplied = str(data.pop('access_token', None) or '')
    if not token_configured():
        return True
    expected = os.environ['SIMULATION_TOKEN'].strip()
    return hmac.compare_digest(supplied.encode(), expected.encode())


def require_unlocked(unlocked):
    """Solleva ``ACCESS_DENIED`` se l'accesso non è pieno."""
    if not unlocked:
        raise ProcessorExecuteError(ACCESS_DENIED)


def public_scenarios():
    """Insieme degli id in ``PUBLIC_SCENARIOS``; vuoto significa nessuna restrizione."""
    raw = os.environ.get('PUBLIC_SCENARIOS', '')
    return {s.strip() for s in raw.split(',') if s.strip()}


def scenario_allowed(scenario_id, unlocked):
    """True se lo scenario si può vedere e analizzare con questo livello d'accesso."""
    if unlocked:
        return True
    allowed = public_scenarios()
    return not allowed or scenario_id in allowed


def require_scenario(scenario_id, unlocked):
    """Solleva ``ACCESS_DENIED`` se lo scenario non è accessibile."""
    if not scenario_allowed(scenario_id, unlocked):
        raise ProcessorExecuteError(ACCESS_DENIED)
