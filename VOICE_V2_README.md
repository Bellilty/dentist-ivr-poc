# Voice V2 - Version de test avec transcription alternative

## 📋 Description

`voice_v2.js` est une version de test qui permet d'expérimenter avec différentes méthodes de transcription STT (Speech-to-Text) pour l'hébreu, sans modifier le code de production `voice.js`.

## 🎯 Objectif

Tester des alternatives à OpenAI Whisper pour réduire la latence de transcription hébreu (actuellement ~8 secondes).

## 🔄 Méthodes de transcription testées

### 1. Google Cloud Speech-to-Text (priorité)

- **Avantages** : Très rapide (~1-2s), streaming possible
- **Configuration** : Nécessite `GOOGLE_CLOUD_SPEECH_KEY` dans les variables d'environnement
- **Fallback** : Si non configuré ou en cas d'erreur, utilise Whisper

### 2. OpenAI Whisper (fallback)

- **Avantages** : Méthode actuelle, très précise
- **Configuration** : Utilise `OPENAI_API_KEY` (déjà configuré)
- **Utilisation** : Fallback automatique si Google Cloud STT échoue

## 🚀 Utilisation

### Option 1 : Via Twilio Console

1. Aller dans Twilio Console → Phone Numbers → Manage → Active Numbers
2. Configurer le webhook pour pointer vers :
   - **Production** : `https://dentist-ivr-poc.vercel.app/api/voice` (version actuelle)
   - **Test** : `https://dentist-ivr-poc.vercel.app/api/voice_v2` (version de test)

### Option 2 : Via Browser Test

Deux pages de test sont disponibles :

- **`/browser-test.html`** : Teste la version production (`/api/voice`)
- **`/browser-test_v2.html`** : Teste la version V2 (`/api/voice_v2`) avec transcription alternative

⚠️ **Important** : Pour que `browser-test_v2.html` fonctionne, vous devez configurer votre numéro Twilio dans la console Twilio pour pointer vers `/api/voice_v2` au lieu de `/api/voice`.

### Option 3 : Via code (pour tests programmatiques)

Les URLs dans `voice_v2.js` pointent vers `/api/voice_v2` au lieu de `/api/voice`.

## ⚙️ Configuration

### Variables d'environnement nécessaires

Pour utiliser Google Cloud Speech-to-Text :

```bash
GOOGLE_CLOUD_SPEECH_KEY=votre_clé_api_google_cloud
```

Pour obtenir une clé :

1. Aller sur [Google Cloud Console](https://console.cloud.google.com/)
2. Activer l'API "Cloud Speech-to-Text"
3. Créer une clé API dans "Credentials"
4. Ajouter la clé dans les variables d'environnement Vercel

### Variables déjà nécessaires (comme voice.js)

- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `OPENAI_API_KEY`
- `GOOGLE_CREDENTIALS_JSON`
- `GOOGLE_TOKEN_JSON`
- `DEFAULT_CALENDAR_ID`
- `CLINIC_TIMEZONE`
- `CLINIC_NAME`
- `DEFAULT_APPT_MINUTES`

## 📊 Comparaison des performances

| Méthode                  | Latence estimée | Précision  | Coût        |
| ------------------------ | --------------- | ---------- | ----------- |
| **Whisper (actuel)**     | ~3-4s           | ⭐⭐⭐⭐⭐ | ~$0.006/min |
| **Google Cloud STT**     | ~1-2s           | ⭐⭐⭐⭐   | ~$0.006/15s |
| **Fallback automatique** | ~3-4s           | ⭐⭐⭐⭐⭐ | Variable    |

## 🔍 Logs

Les logs de `voice_v2.js` sont préfixés avec `[V2]` pour faciliter le debugging :

- `🟢 [V2] STEP: ...`
- `🎙️ [V2] Hebrew mode — fetching & transcribing…`
- `🧠 [V2] Extracted speech: ...`

## 🧪 Tests

Pour tester les deux versions en parallèle :

1. Configurer deux numéros Twilio différents
2. Pointer l'un vers `/api/voice` et l'autre vers `/api/voice_v2`
3. Comparer les temps de réponse

## 📝 Notes

- `voice.js` reste inchangé et fonctionne comme avant
- Les deux versions peuvent coexister sans conflit
- `voice_v2.js` utilise les mêmes fonctions Google Calendar que `voice.js`
- Le fallback automatique garantit que ça fonctionne même sans Google Cloud configuré

## 🔮 Prochaines étapes possibles

1. **Azure Speech Services** : Ajouter comme alternative supplémentaire
2. **Vosk (local)** : Si on migre vers un serveur dédié (pas serverless)
3. **Streaming temps réel** : Utiliser Twilio Media Streams pour transcription en temps réel
4. **Cache de transcription** : Pour éviter de retranscrire les mêmes phrases
