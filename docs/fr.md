# Automate Pulse Hub v2

Cette intégration amène dans Gladys les stores **Rollease Acmeda Automate**
appairés à un **Pulse Hub v2**. Chaque store devient un **volet** de l'onglet
Découverte : ouverture, fermeture, arrêt, sa position, et le niveau de batterie
des moteurs sur batterie. Tout reste sur votre réseau local ; le cloud de
Rollease Acmeda n'est pas utilisé. Non officiel, sans lien avec Rollease Acmeda.

> **Version de développement.** Cette intégration n'a **jamais été testée avec
> un vrai hub** : seulement avec un hub simulé. Le protocole local du hub n'est
> pas documenté par Rollease Acmeda ; il vient de la bibliothèque aiopulse2
> (l'intégration Home Assistant). Vos retours sont bienvenus dans les
> [issues GitHub](https://github.com/LM1LC3N7/gladys-automate-pulse/issues).

## Avant de commencer

1. Installez le hub et ses stores dans l'application **Automate Pulse 2**, et
   nommez-y les stores : Gladys reprend leurs noms depuis le hub.
2. Donnez au hub une adresse IP fixe dans votre box (réservation DHCP).
3. Le Pulse Hub **v1** n'est pas pris en charge (autre protocole).

## Configuration

- **Adresse du hub** : son adresse IP, par exemple `192.168.1.50`.
- **Empreinte du certificat** (facultatif) : le hub utilise un certificat TLS
  auto-signé. Vide, le certificat rencontré à la première connexion est gardé ;
  si un autre apparaît plus tard (nouveau hub, réinitialisation, ou autre
  machine à cette adresse), tout s'arrête et le statut affiche son empreinte
  SHA-256. Si c'est votre hub, appuyez deux fois sur **Faire confiance au
  nouveau certificat** (dans les 60 s), ou saisissez cette empreinte dans ce
  champ.
- **Intervalle de lecture** : fréquence à laquelle l'état des stores est
  demandé (10 s par défaut, de 5 à 300 s). Après une commande, le store est
  aussi lu à 1,5, 4, 10, 25 et 50 s.
- **Langue des noms des fonctionnalités**.

Ouvrez ensuite l'onglet **Découverte** et ajoutez les stores.

## Ce que vous obtenez

| Fonctionnalité        | Gladys          | Remarques                                                                        |
| --------------------- | --------------- | -------------------------------------------------------------------------------- |
| Ouverture / fermeture | volet, état     | ouvrir, fermer, arrêter                                                          |
| Position              | volet, position | 0 fermé .. 100 ouvert                                                            |
| Batterie              | batterie, %     | moteurs sur batterie seulement, estimée d'après la tension (comme l'application) |

Un store n'est jamais un interrupteur : un « éteins tout » ne le fait jamais
bouger.

## Comportement des commandes

- Un mouvement part dans les 3,5 s qui suivent votre clic, sinon il est refusé
  (rien n'est envoyé). Il est « accepté » dès que le hub indique que le store
  bouge ou y est déjà ; si le hub ne le dit pas à temps, Gladys affiche
  **« envoyée, sans confirmation »** et relit le store. La position n'est
  confirmée que quand le hub la donne ; une position non atteinte à la fin
  s'affiche sur le badge.
- **Arrêt** n'attend jamais : il part tout de suite, même quand le hub a
  demandé d'attendre (un seul essai), et annule un mouvement pas encore envoyé.
- La batterie et le type de moteur viennent rarement du hub : ils sont demandés
  au plus une fois par heure et par store, la batterie peut donc apparaître un
  peu plus tard.

## Limites

- Un seul hub par intégration dans cette version.
- Les noms des stores sont lus sur le second port du hub (TCP 1487) ; s'il ne
  répond pas, un store est nommé d'après son identifiant (« Store ABC »).
- Un hub qui refuse les connexions (HTTP 429 ou 5xx) est laissé tranquille de
  1 minute à 6 heures ; les autres échecs sont réessayés après 10 s, 30 s, 1, 2
  et 5 minutes, jamais plus vite que l'intervalle de lecture, redémarrage
  compris.
- Rien n'est secret ici : le hub n'a pas de mot de passe.
