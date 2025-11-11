# Voice V2 - Version de test avec transcription alternative

## 📋 Description

`voice_v2.js` est une version de test qui permet d'expérimenter avec différentes méthodes de transcription STT (Speech-to-Text) pour l'hébreu, sans modifier le code de production `voice.js`.

## 🎯 Objectif

Tester des alternatives à OpenAI Whisper pour réduire la latence de transcription hébreu (actuellement ~8 secondes).

## 🔄 Méthodes de transcription open source testées

### 1. Hugging Face Inference API (Whisper open source) - Priorité

- **Avantages** : Gratuit, open source, basé sur Whisper, supporte hébreu et anglais
- **Modèles** : `openai/whisper-small` (hébreu), `openai/whisper-base` (anglais)
- **Configuration** : Optionnel - `HUGGINGFACE_API_KEY` (gratuit sans clé mais avec rate limit)
- **Source** : [Hugging Face Models](https://huggingface.co/models?search=whisper)
- **Fallback** : Si échoue, essaie Gladia puis OpenAI Whisper

### 2. Gladia API (open source)

- **Avantages** : Open source, gratuit avec plan free, supporte hébreu et anglais
- **Configuration** : Nécessite `GLADIA_API_KEY` (gratuit sur [gladia.io](https://www.gladia.io))
- **Utilisation** : Fallback si Hugging Face échoue
- **Source** : [Gladia.io](https://www.gladia.io)

### 3. OpenAI Whisper (fallback final)

- **Avantages** : Très précis, méthode de référence
- **Configuration** : Utilise `OPENAI_API_KEY` (déjà configuré)
- **Utilisation** : Fallback final si les solutions open source échouent

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

**Optionnel - Hugging Face (recommandé pour commencer) :**

```bash
HUGGINGFACE_API_KEY=votre_clé_huggingface  # Optionnel, gratuit sans clé
```

Pour obtenir une clé Hugging Face (optionnel) :

1. Aller sur [Hugging Face](https://huggingface.co/settings/tokens)
2. Créer un token d'accès
3. Ajouter dans les variables d'environnement Vercel

**Optionnel - Gladia (alternative) :**

```bash
GLADIA_API_KEY=votre_clé_gladia
```

Pour obtenir une clé Gladia :

1. Aller sur [Gladia.io](https://www.gladia.io)
2. Créer un compte gratuit
3. Obtenir votre clé API
4. Ajouter dans les variables d'environnement Vercel

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

| Méthode                  | Latence estimée | Précision  | Coût        | Type         |
| ------------------------ | --------------- | ---------- | ----------- | ------------ |
| **Hugging Face Whisper** | ~2-4s           | ⭐⭐⭐⭐   | Gratuit     | Open Source  |
| **Gladia**               | ~2-3s           | ⭐⭐⭐⭐   | Gratuit     | Open Source  |
| **OpenAI Whisper**       | ~3-4s           | ⭐⭐⭐⭐⭐ | ~$0.006/min | Propriétaire |
| **Fallback automatique** | ~3-4s           | ⭐⭐⭐⭐⭐ | Variable    | Mixte        |

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
