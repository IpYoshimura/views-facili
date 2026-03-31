# 🔧 ISTRUZIONI PER AGGIORNARE IL SITO SU RENDER

## Il problema
Il sito mostra una versione vecchia perché Render ha la **build cache bloccata**.

## La soluzione - Segui questi step:

### Step 1: Vai al dashboard di Render
1. Apri https://dashboard.render.com
2. Accedi con il tuo account

### Step 2: Seleziona il servizio
1. Clicca su "Views Facili" (o il nome del tuo servizio)
2. Vedrai la pagina del servizio

### Step 3: Pulisci la build cache
**OPZIONE A - Se vedi un pulsante "Clear Build Cache":**
1. Vai a Settings → Build & Deploy
2. Clicca "Clear Build Cache"
3. Aspetta che finisca (max 1-2 minuti)

**OPZIONE B - Se non lo vedi:**
1. Torna alla homepage del servizio
2. Guarda il menu in alto a destra (3 puntini ⋮ o More)
3. Cerca "Clear cache" o "Manual deploy"

### Step 4: Foza il deploy
1. Clicca "Deploy Latest" o "Manual Deploy"
2. Render inizierà a ricostruire (vedrai una progress bar)
3. Aspetta che finisca (5-15 minuti)

### Step 5: Verifica
1. Una volta finito il deploy, il sito si aggiornerà automaticamente
2. Aggiorna il browser (F5 o Cmd+R)
3. Dovrai vederne le modifiche: **views/hora rimosse**, rimangono solo views, likes, comments, engagement%

## Se ancora non funziona:
- Cancella la cache del browser (Ctrl+Shift+Delete)
- Prova da un browser diverso o in incognito
- Contatta il supporto di Render se il deploy fallisce

## Cosa è stato cambiato:
✅ Views/ora rimosse dalla visualizzazione della card
✅ Rimangono: 👁 Views | 👍 Likes | 💬 Comments | 📊 Engagement%
✅ Cache headers aggiunti per forzare refresh del browser
✅ Timestamp query param aggiunto al client.js

Tutti i 5 commit sono già su GitHub - Render li ha ricevuti, ma la cache lo blocca dal deployarli.
