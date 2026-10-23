// -----------------------------------------------------------------------------
// Texts shown in Gladys (connection status, refusals of commands, badges,
// feature names), in English and French.
// -----------------------------------------------------------------------------

import { LIMITS } from './constants.js';

/** Feature names, by key. */
const LABELS = {
  state: { en: 'Open / close', fr: 'Ouverture / fermeture' },
  position: { en: 'Position', fr: 'Position' },
  battery: { en: 'Battery', fr: 'Batterie' },
};

/** The label of a key in a language. */
export function label(key, language = 'fr') {
  return LABELS[key]?.[language] ?? LABELS[key]?.en ?? key;
}

/** One text of a { en, fr } pair, in a language. */
export const word = (pair, language = 'fr') => pair?.[language] ?? pair?.en ?? '';

/** Pairs joined by a space (undefined ones skipped). */
export const join = (...pairs) => {
  const list = pairs.filter(Boolean);
  return {
    en: list.map((p) => p.en).join(' '),
    fr: list.map((p) => p.fr).join(' '),
  };
};

/** A duration: "45 s", "3 min", "2 h". */
export function age(ms) {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 90) {
    return `${s} s`;
  }
  const min = Math.round(s / 60);
  return min < 90 ? `${min} min` : `${Math.round(min / 60)} h`;
}

const trim = (text, max = LIMITS.badgeMessage) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** Why the hub failed, in English and French (never an address). */
export function reasonOf(err) {
  const http = err?.status !== undefined ? ` (HTTP ${err.status})` : '';
  switch (err?.kind) {
    case 'unreachable':
      return { en: 'no connection', fr: 'pas de connexion' };
    case 'timeout':
      return { en: 'no answer in time', fr: 'pas de réponse à temps' };
    case 'silent':
      return { en: 'the hub stopped answering', fr: 'le hub ne répond plus' };
    case 'closed':
      return { en: 'connection closed', fr: 'connexion fermée' };
    case 'tooLarge':
      return { en: 'answer too large', fr: 'réponse trop grande' };
    case 'format':
    case 'http':
      return { en: `not a Pulse Hub v2${http}`, fr: `pas un Pulse Hub v2${http}` };
    case 'rate':
      return { en: 'too many requests (HTTP 429)', fr: 'trop de demandes (HTTP 429)' };
    case 'server':
      return { en: `hub error${http}`, fr: `erreur du hub${http}` };
    case 'certificate':
      return { en: 'another certificate', fr: 'autre certificat' };
    default:
      return { en: 'unexpected error', fr: 'erreur inattendue' };
  }
}

export const T = {
  noAddress: {
    en: 'Type the IP address of your Pulse Hub v2, then save.',
    fr: 'Saisissez l’adresse IP de votre Pulse Hub v2, puis enregistrez.',
  },
  invalid: (text) => ({
    en: `"${text}" is not an address: type an IP address like 192.168.1.50.`,
    fr: `« ${text} » n’est pas une adresse : saisissez une adresse IP comme 192.168.1.50.`,
  }),
  local: {
    en: 'Names in .local do not work from the container: type the IP address.',
    fr: 'Les noms en .local ne fonctionnent pas depuis le conteneur : saisissez l’adresse IP.',
  },
  credentialsInHost: {
    en: 'The address holds a user name or a password: type the IP address only.',
    fr: 'L’adresse contient un nom d’utilisateur ou un mot de passe : saisissez seulement l’adresse IP.',
  },
  pinInvalid: {
    en: 'The certificate fingerprint must be a SHA-256 fingerprint (64 hexadecimal digits, colons allowed), or empty: it is ignored.',
    fr: 'L’empreinte du certificat doit être une empreinte SHA-256 (64 caractères hexadécimaux, deux-points permis), ou vide : elle est ignorée.',
  },
  certificateChanged: (fingerprint) => ({
    en: `The TLS certificate of the hub is not the one Gladys knows (a new hub, a reset, or another machine at this address). Nothing is sent until you vouch for it, whatever you save. Its SHA-256 fingerprint: ${fingerprint}. If it is your hub, press "Trust the new certificate" twice, or type it in the fingerprint field.`,
    fr: `Le certificat TLS du hub n’est pas celui que Gladys connaît (nouveau hub, réinitialisation, ou autre machine à cette adresse). Rien n’est envoyé tant que vous ne le validez pas, quoi que vous enregistriez. Son empreinte SHA-256 : ${fingerprint}. Si c’est votre hub, appuyez deux fois sur « Faire confiance au nouveau certificat », ou saisissez-la dans le champ de l’empreinte.`,
  }),
  certificateNotTyped: (fingerprint) => ({
    en: `The TLS certificate of the hub is not the one whose fingerprint you typed. Nothing is sent. The hub shows: ${fingerprint}. If it is the right one, type it in the fingerprint field (or empty the field and press "Trust the new certificate" twice).`,
    fr: `Le certificat TLS du hub n’est pas celui dont vous avez saisi l’empreinte. Rien n’est envoyé. Le hub présente : ${fingerprint}. Si c’est le bon, saisissez-la dans le champ de l’empreinte (ou videz le champ et appuyez deux fois sur « Faire confiance au nouveau certificat »).`,
  }),
  paused: (wait, reason) => ({
    en: `The hub asked to wait (${reason.en}): next try in ${wait}. "Stop" still works.`,
    fr: `Le hub a demandé d’attendre (${reason.fr}) : nouvel essai dans ${wait}. « Arrêt » fonctionne toujours.`,
  }),
  connecting: {
    en: 'Connecting to the hub…',
    fr: 'Connexion au hub…',
  },
  noIdentity: {
    en: 'The hub answers but gives neither its MAC address nor its id: its shades are not published.',
    fr: 'Le hub répond mais ne donne ni son adresse MAC ni son identifiant : ses stores ne sont pas publiés.',
  },
  unreachable: (reason, wait) => ({
    en: `The hub does not answer (${reason.en}): next try in ${wait}.`,
    fr: `Le hub ne répond pas (${reason.fr}) : nouvel essai dans ${wait}.`,
  }),
  connected: ({ name, shades, online, interval }) => ({
    en: `Connected to the hub${name ? ` "${name}"` : ''}: ${shades} shade(s), ${online} reachable, read every ${interval} s.`,
    fr: `Connecté au hub${name ? ` « ${name} »` : ''} : ${shades} store(s), ${online} joignable(s), lu toutes les ${interval} s.`,
  }),
  test: {
    recent: (wait) => ({
      en: `Last try less than an interval ago: next one possible in ${wait}.`,
      fr: `Dernier essai il y a moins d’un intervalle : prochain possible dans ${wait}.`,
    }),
  },
  trustNothing: {
    en: 'No other certificate was met: nothing to trust.',
    fr: 'Aucun autre certificat rencontré : rien à valider.',
  },
  trustTyped: (fingerprint) => ({
    en: `The fingerprint field holds another fingerprint: type ${fingerprint} there, or empty it, then save and press the button again.`,
    fr: `Le champ de l’empreinte en contient une autre : saisissez-y ${fingerprint}, ou videz-le, puis enregistrez et appuyez de nouveau.`,
  }),
  trustConfirm: (fingerprint) => ({
    en: `Press again within 60 s to trust the certificate ${fingerprint} (compare it with the one of your hub first).`,
    fr: `Appuyez de nouveau dans les 60 s pour faire confiance au certificat ${fingerprint} (comparez-le d’abord avec celui de votre hub).`,
  }),
  trustDone: (fingerprint) => ({
    en: `Certificate ${fingerprint} trusted: connecting.`,
    fr: `Certificat ${fingerprint} validé : connexion en cours.`,
  }),
  badge: {
    unconfirmed: {
      en: trim('Command sent, without confirmation from the hub yet.'),
      fr: trim('Commande envoyée, sans confirmation du hub pour l’instant.'),
    },
    notReached: (position) => ({
      en: trim(`The position asked was not reached (read: ${position} %).`),
      fr: trim(`La position demandée n’a pas été atteinte (lue : ${position} %).`),
    }),
  },
};

/** Refusals of a command (the error message Gladys shows). */
export const ERRORS = {
  generic: { en: 'Unexpected error.', fr: 'Erreur inattendue.' },
  readOnly: { en: 'This feature is read only.', fr: 'Cette fonctionnalité est en lecture seule.' },
  badValue: { en: 'Value not understood.', fr: 'Valeur non comprise.' },
  unknownDevice: {
    en: 'This shade is not on the hub of the configuration.',
    fr: 'Ce store n’est pas sur le hub de la configuration.',
  },
  notConnected: {
    en: 'The hub is not connected: nothing sent.',
    fr: 'Le hub n’est pas connecté : rien n’a été envoyé.',
  },
  certificate: {
    en: 'The certificate of the hub changed: nothing sent until you vouch for it.',
    fr: 'Le certificat du hub a changé : rien n’est envoyé tant que vous ne l’avez pas validé.',
  },
  otherHub: {
    en: 'Another hub answers at this address: nothing sent.',
    fr: 'Un autre hub répond à cette adresse : rien n’a été envoyé.',
  },
  identityUnknown: {
    en: 'The hub did not report its shades in time: nothing sent.',
    fr: 'Le hub n’a pas donné ses stores à temps : rien n’a été envoyé.',
  },
  unknownShade: {
    en: 'The hub does not report this shade: nothing sent.',
    fr: 'Le hub ne donne pas ce store : rien n’a été envoyé.',
  },
  tooSlow: {
    en: 'The hub was too slow: nothing sent, try again.',
    fr: 'Le hub était trop lent : rien n’a été envoyé, réessayez.',
  },
  stopped: {
    en: 'Cancelled by a stop: nothing sent.',
    fr: 'Annulée par un arrêt : rien n’a été envoyé.',
  },
  configChanged: {
    en: 'The configuration changed meanwhile: nothing sent.',
    fr: 'La configuration a changé entre-temps : rien n’a été envoyé.',
  },
  notSent: {
    en: 'The connection to the hub closed: nothing sent.',
    fr: 'La connexion au hub s’est fermée : rien n’a été envoyé.',
  },
  sentUnconfirmed: {
    en: 'Sent, without confirmation from the hub: the shade is read again in a moment.',
    fr: 'Envoyée, sans confirmation du hub : le store est relu dans un instant.',
  },
};
