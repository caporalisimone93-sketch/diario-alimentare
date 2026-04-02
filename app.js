// REGISTRAZIONE SERVICE WORKER (PWA)
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js')
      .then(() => console.log("Service Worker Registrato"))
      .catch(err => console.log("Errore SW:", err));
}

// CONFIGURAZIONE API
const API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

function salvaApiKey() {
    const keyInput = document.getElementById('api-key-input');
    const key = keyInput.value.trim();
    if (key) {
        localStorage.setItem('gemini_api_key', key);
        alert("Chiave API salvata localmente sul dispositivo!");
        keyInput.value = "";
    } else {
        alert("Inserisci una chiave valida.");
    }
}

function ottieniApiKey() {
    return localStorage.getItem('gemini_api_key');
}

// DATABASE (DEXIE)
const db = new Dexie("DiarioAlimentareDB");
db.version(3).stores({
    pastiTipici: 'nome, descrizione, calorie, proteine, carboidrati, grassi',
    diario: 'data, calorieMangiate, proteine, carbo, grassi, calorieBruciate'
});

// PROTEZIONE XSS
function escapeHTML(str) {
    const p = document.createElement('p');
    p.textContent = str;
    return p.innerHTML;
}

// CRONOLOGIA CHAT (in memoria, per contesto Gemini)
let cronologiaChat = [];
const MAX_MESSAGGI_CONTESTO = 10;

function aggiungiACronologia(ruolo, testo) {
    cronologiaChat.push({ role: ruolo, parts: [{ text: testo }] });
    if (cronologiaChat.length > MAX_MESSAGGI_CONTESTO) {
        cronologiaChat = cronologiaChat.slice(-MAX_MESSAGGI_CONTESTO);
    }
}

// STATO INVIO (anti doppio invio)
let invioInCorso = false;

function bloccaInvio() {
    invioInCorso = true;
    const btn = document.getElementById('btn-invia');
    const input = document.getElementById('user-input');
    btn.disabled = true;
    btn.textContent = '...';
    input.disabled = true;
    document.getElementById('btn-foto').disabled = true;
}

function sbloccaInvio() {
    invioInCorso = false;
    const btn = document.getElementById('btn-invia');
    const input = document.getElementById('user-input');
    btn.disabled = false;
    btn.textContent = 'Invia';
    input.disabled = false;
    document.getElementById('btn-foto').disabled = false;
    input.focus();
}

// GESTIONE FOTO
let fotoAllegata = null; // { base64, mimeType }

function anteprimaFoto(input) {
    const file = input.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
            // Ridimensiona a max 1024px per lato
            const MAX = 1024;
            let w = img.width, h = img.height;
            if (w > MAX || h > MAX) {
                if (w > h) { h = Math.round(h * MAX / w); w = MAX; }
                else { w = Math.round(w * MAX / h); h = MAX; }
            }
            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            canvas.getContext('2d').drawImage(img, 0, 0, w, h);
            
            const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
            const base64 = dataUrl.split(',')[1];
            fotoAllegata = { base64, mimeType: 'image/jpeg' };
            
            document.getElementById('anteprima-img').src = dataUrl;
            document.getElementById('anteprima-foto').style.display = 'block';
            document.getElementById('btn-foto').classList.add('ha-foto');
        };
        img.src = e.target.result;
    };
    reader.readAsDataURL(file);
}

function rimuoviFoto() {
    fotoAllegata = null;
    document.getElementById('anteprima-foto').style.display = 'none';
    document.getElementById('btn-foto').classList.remove('ha-foto');
    document.getElementById('foto-input').value = '';
}

// RESET DATI
async function resetDatiGiorno(giorniIndietro) {
    const dataTarget = ottieniData(giorniIndietro);
    const confermi = confirm(`Vuoi davvero azzerare i pasti e l'allenamento di ${giorniIndietro === 0 ? 'OGGI' : 'IERI'} (${dataTarget})?`);
    
    if (confermi) {
        const recordEsistente = await db.diario.get(dataTarget);
        if (recordEsistente) {
            await db.diario.update(dataTarget, {
                calorieMangiate: 0, proteine: 0, carbo: 0, grassi: 0, calorieBruciate: 0
            });
            alert("Dati resettati!");
            if (document.getElementById("dashboard-box").style.display === "block") disegnaGrafico();
        }
    }
}

function ottieniData(giorniIndietro = 0) {
    const d = new Date();
    d.setDate(d.getDate() - giorniIndietro);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function ottieniTDEEAttuale() {
    const tuttiIDati = await db.diario.orderBy('data').reverse().toArray();
    const recordConTDEE = tuttiIDati.find(d => d.tdee);
    return recordConTDEE ? recordConTDEE.tdee : null;
}

// LOGICA CHAT
async function inviaMessaggio() {
    if (invioInCorso) return;

    const inputField = document.getElementById("user-input");
    const testoUtente = inputField.value.trim();
    const foto = fotoAllegata;
    
    if (!testoUtente && !foto) return;

    const apiKey = ottieniApiKey();
    if (!apiKey) {
        alert("Manca la API Key! Vai nella Dashboard in fondo per configurarla.");
        return;
    }

    bloccaInvio();
    
    // Mostra messaggio utente con eventuale miniatura foto
    const chatBox = document.getElementById("chat-box");
    const msgUtente = document.createElement("p");
    let htmlUtente = `<strong>Tu:</strong> `;
    if (foto) htmlUtente += `<img src="data:${foto.mimeType};base64,${foto.base64}" style="max-height:60px; border-radius:4px; vertical-align:middle; margin-right:6px;">`;
    if (testoUtente) htmlUtente += escapeHTML(testoUtente);
    else if (foto) htmlUtente += `<em style="color:#999;">foto allegata</em>`;
    msgUtente.innerHTML = htmlUtente;
    chatBox.appendChild(msgUtente);
    
    inputField.value = "";
    rimuoviFoto();
    
    // Messaggio placeholder con animazione
    const loadingMsg = document.createElement("p");
    loadingMsg.innerHTML = `<strong>Dietologo:</strong> <span class="loading-dots">Sto pensando</span>`;
    chatBox.appendChild(loadingMsg);
    chatBox.scrollTop = chatBox.scrollHeight;

    try {
        const risultato = await faiDomandaAGemini(testoUtente || "Analizza questa foto", apiKey, foto);
        let html = `<strong>Dietologo:</strong> ${escapeHTML(risultato.testo).replace(/\n/g, "<br>")}`;
        
        // Badge conferma registrazione
        if (risultato.conferma) {
            const c = risultato.conferma;
            if (c.kcal || c.bruciate || c.p || c.c || c.g) {
                const isCorrezione = c.kcal < 0 || c.p < 0 || c.c < 0 || c.g < 0;
                const parti = [];
                if (c.kcal) parti.push(`${c.kcal > 0 ? '+' : ''}${c.kcal} kcal`);
                if (c.p) parti.push(`P ${c.p > 0 ? '+' : ''}${c.p}g`);
                if (c.c) parti.push(`C ${c.c > 0 ? '+' : ''}${c.c}g`);
                if (c.g) parti.push(`G ${c.g > 0 ? '+' : ''}${c.g}g`);
                if (c.bruciate) parti.push(`🏃 -${c.bruciate} kcal`);
                
                const giorno = c.data !== ottieniData(0) ? ` (${c.data})` : '';
                const etichetta = isCorrezione ? '✏️ Corretto' : '✓ Registrato';
                const classe = isCorrezione ? 'conferma-correzione' : 'conferma-registrazione';
                html += `<div class="${classe}">${etichetta}${giorno}: ${parti.join(' | ')}</div>`;
            }
            if (c.pastoSalvato) {
                html += `<div class="conferma-pasto-salvato">✓ Pasto "${escapeHTML(c.pastoSalvato)}" salvato nei preferiti</div>`;
            }
        }
        
        loadingMsg.innerHTML = html;
    } catch (error) {
        loadingMsg.innerHTML = `<strong>Errore:</strong> ${escapeHTML(error.message)}`;
    } finally {
        sbloccaInvio();
        chatBox.scrollTop = chatBox.scrollHeight;
    }
}

async function faiDomandaAGemini(testo, apiKey, foto = null) {
    const dataOggi = ottieniData(0);
    const dataIeri = ottieniData(1);
    
    const recordOggi = await db.diario.get(dataOggi) || { calorieMangiate: 0, calorieBruciate: 0 };
    const recordIeri = await db.diario.get(dataIeri) || { calorieMangiate: 0, calorieBruciate: 0 };
    const pastiSalvati = await db.pastiTipici.toArray();
    
    let memoriaPasti = pastiSalvati.length > 0
        ? "Pasti salvati dall'utente: " + pastiSalvati.map(p => 
            `"${p.nome}" = ${p.descrizione} (${p.calorie}kcal, P:${p.proteine}g C:${p.carboidrati}g G:${p.grassi}g)`
          ).join("; ")
        : "L'utente non ha ancora salvato nessun pasto tipico.";
    
    const tdeeAttuale = await ottieniTDEEAttuale();
    const tdeeInfo = tdeeAttuale 
        ? `Fabbisogno TDEE: ${Math.round(tdeeAttuale)} kcal.` 
        : "TDEE non ancora configurato (l'utente non ha compilato il profilo fisico).";

    // Storico ultimi 30 giorni per domande analitiche
    const trentaGiorniFa = new Date();
    trentaGiorniFa.setDate(trentaGiorniFa.getDate() - 30);
    const storicoDiario = (await db.diario.toArray())
        .filter(d => new Date(d.data) >= trentaGiorniFa)
        .sort((a, b) => a.data.localeCompare(b.data))
        .map(d => `${d.data}: ${d.calorieMangiate||0}kcal P:${d.proteine||0}g C:${d.carbo||0}g G:${d.grassi||0}g bruciato:${d.calorieBruciate||0}kcal${d.tdee ? ' TDEE:'+d.tdee : ''}${d.peso ? ' peso:'+d.peso+'kg' : ''}`)
        .join('\n');

    const systemInstruction = `Sei un dietologo sintetico in un'app di tracking calorico. Analizza l'input dell'utente.

REGOLE RIGIDE:
1. Capisci se l'utente parla di OGGI (${dataOggi}) o di IERI (${dataIeri}).
2. Rispondi SOLO con l'analisi del nuovo pasto/allenamento e un commento tecnico brevissimo.
3. Dati già salvati: OGGI = ${recordOggi.calorieMangiate} kcal mangiate / ${recordOggi.calorieBruciate} kcal bruciate. IERI = ${recordIeri.calorieMangiate} kcal mangiate / ${recordIeri.calorieBruciate} kcal bruciate.
4. ${memoriaPasti}
5. ${tdeeInfo}

STORICO DIARIO (ultimi 30 giorni, usalo per rispondere a domande analitiche come medie, totali, trend):
${storicoDiario || 'Nessun dato registrato.'}

RISPOSTE ANALITICHE: quando l'utente chiede medie, totali o trend, dai SOLO il risultato finale con il periodo di riferimento. Niente elenchi giorno per giorno, niente passaggi intermedi, niente formule. Esempio: "Questa settimana hai un deficit totale di 469 kcal su 2 giorni tracciati. Media proteine: 116g/giorno."

PASTI SALVATI:
- Se l'utente menziona il NOME di un pasto salvato (es. "ho mangiato la solita colazione"), USA i valori nutrizionali salvati, NON stimare da zero.
- Se l'utente chiede di SALVARE un alimento o pasto (es. "salva come pranzo classico", "salvalo come X"), aggiungi il campo "salva_pasto" nel JSON con nome e descrizione.
- COMPOSIZIONE: se l'utente compone un pasto da alimenti già salvati (es. "salva come colazione: yogurt Fage + crema nocciole + cereali"), DEVI sommare i valori dei singoli alimenti salvati, NON stimare. Usa i valori esatti dal database.
- VALORI PARZIALI: se l'utente fornisce solo alcuni valori (es. "salva questo yogurt, ha 120 kcal e 10g proteine"), usa quelli forniti e stima SOLO i macro mancanti.
- FOTO ETICHETTA + SALVATAGGIO: se l'utente manda la foto di un'etichetta e chiede di salvare, estrai i valori esatti dall'etichetta.
- AGGIORNAMENTO: se l'utente chiede di aggiornare un alimento già salvato (es. "aggiorna lo Yogurt Fage, in realtà ha 97 kcal"), salva con lo stesso nome — il vecchio viene sovrascritto automaticamente. Nella risposta conferma i vecchi e i nuovi valori.
- SOLO SALVATAGGIO: se l'utente vuole solo salvare un prodotto senza registrarlo nel diario di oggi (es. "salva questo prodotto ma non l'ho mangiato oggi"), metti tutti i valori nutrizionali a 0 nel JSON principale e usa salva_pasto per salvare i valori reali.

CORREZIONI:
- Se l'utente corregge un valore precedente (es. "no erano 400 kcal", "le proteine erano 30g", "togli l'ultimo pasto"), calcola la DIFFERENZA rispetto a quanto avevi registrato prima e usa valori NEGATIVI nel JSON.
- Esempio: se avevi registrato 500 kcal e l'utente dice "erano 400", metti calorie_mangiate: -100.
- Per cancellare un pasto intero, metti i valori negativi corrispondenti a quel pasto.
- Conferma brevemente la correzione nella risposta testuale.

IMPORTANTE: i valori nel JSON sono sempre DELTA (differenze da sommare al totale giornaliero). Per nuovi pasti sono positivi, per correzioni possono essere negativi.

Formato JSON obbligatorio alla fine della risposta:
\`\`\`json
{
  "data_riferimento": "${dataOggi}",
  "calorie_mangiate": 0,
  "proteine": 0,
  "carboidrati": 0,
  "grassi": 0,
  "calorie_bruciate": 0,
  "salva_pasto": null
}
\`\`\`

Se l'utente vuole salvare un pasto, il campo salva_pasto diventa:
\`\`\`json
"salva_pasto": {
  "nome": "nome del pasto",
  "descrizione": "descrizione testuale degli alimenti",
  "calorie": 0,
  "proteine": 0,
  "carboidrati": 0,
  "grassi": 0
}
\`\`\`
I valori dentro salva_pasto sono quelli REALI dell'alimento/pasto da salvare nel database. Normalmente coincidono con i valori nel JSON principale, ma nel caso "salva senza registrare nel diario" il JSON principale ha valori 0 mentre salva_pasto ha i valori reali.

Se il messaggio dell'utente è una domanda generica, una domanda analitica sui dati (medie, totali, deficit, trend), conversazione, o non riguarda un nuovo pasto/allenamento da registrare, rispondi normalmente SENZA blocco JSON.

FOTO: l'utente può allegare foto di etichette nutrizionali o di alimenti. Se ricevi un'immagine, leggila attentamente ed estrai i valori nutrizionali. Per le etichette, usa i valori esatti riportati. Per foto di cibo, stima al meglio.`;

    // Costruisci le parts del messaggio utente (testo + eventuale immagine)
    const userParts = [];
    if (foto) {
        userParts.push({ inline_data: { mime_type: foto.mimeType, data: foto.base64 } });
    }
    userParts.push({ text: testo });

    // Nella cronologia salva solo il testo (no base64)
    aggiungiACronologia("user", foto ? `[foto allegata] ${testo}` : testo);

    // Costruisci contents: cronologia precedente + messaggio corrente con immagine
    const contenutiPrecedenti = cronologiaChat.slice(0, -1);
    const messaggioCorrente = { role: "user", parts: userParts };

    const requestBody = {
        system_instruction: {
            parts: [{ text: systemInstruction }]
        },
        contents: [...contenutiPrecedenti, messaggioCorrente]
    };

    const response = await fetch(`${API_URL}?key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody)
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Errore API');
    
    const testoRisposta = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!testoRisposta) throw new Error('Risposta vuota o bloccata dai filtri di sicurezza.');

    // Aggiungi risposta alla cronologia
    aggiungiACronologia("model", testoRisposta);

    // Parsing JSON dalla risposta
    let conferma = null;
    try {
        const jsonMatch = testoRisposta.match(/```(?:json|JSON)?\s*\n?([\s\S]*?)```/);
        if (jsonMatch) {
            const datiNuovi = JSON.parse(jsonMatch[1].trim());
            
            // Salva nel diario se ci sono dati nutrizionali o allenamento
            if (datiNuovi.calorie_mangiate || datiNuovi.calorie_bruciate || datiNuovi.proteine || datiNuovi.carboidrati || datiNuovi.grassi) {
                await aggiornaDiario(datiNuovi);
                conferma = { 
                    kcal: datiNuovi.calorie_mangiate || 0,
                    p: datiNuovi.proteine || 0,
                    c: datiNuovi.carboidrati || 0,
                    g: datiNuovi.grassi || 0,
                    bruciate: datiNuovi.calorie_bruciate || 0,
                    data: datiNuovi.data_riferimento || ottieniData(0)
                };
            }
            
            // Salva pasto tipico se richiesto
            if (datiNuovi.salva_pasto && datiNuovi.salva_pasto.nome) {
                const sp = datiNuovi.salva_pasto;
                await salvaPastoTipico(
                    sp.nome,
                    sp.descrizione || '',
                    sp.calorie || datiNuovi.calorie_mangiate || 0,
                    sp.proteine || datiNuovi.proteine || 0,
                    sp.carboidrati || datiNuovi.carboidrati || 0,
                    sp.grassi || datiNuovi.grassi || 0
                );
                conferma = conferma || {};
                conferma.pastoSalvato = datiNuovi.salva_pasto.nome;
            }
        }
    } catch(e) { console.error("Errore parsing JSON dalla risposta:", e); }

    // Restituisci testo + dati conferma
    const testoPulito = testoRisposta.replace(/```(?:json|JSON)?\s*\n?[\s\S]*?```/g, '').trim();
    return { testo: testoPulito, conferma };
}

async function aggiornaDiario(datiNuovi) {
    const dataTarget = datiNuovi.data_riferimento || ottieniData(0);
    const recordTarget = await db.diario.get(dataTarget) || { calorieMangiate: 0, proteine: 0, carbo: 0, grassi: 0, calorieBruciate: 0 };

    await db.diario.put({
        ...recordTarget,
        data: dataTarget,
        calorieMangiate: Math.max(0, (recordTarget.calorieMangiate || 0) + (datiNuovi.calorie_mangiate || 0)),
        proteine: Math.max(0, (recordTarget.proteine || 0) + (datiNuovi.proteine || 0)),
        carbo: Math.max(0, (recordTarget.carbo || 0) + (datiNuovi.carboidrati || 0)),
        grassi: Math.max(0, (recordTarget.grassi || 0) + (datiNuovi.grassi || 0)),
        calorieBruciate: Math.max(0, (recordTarget.calorieBruciate || 0) + (datiNuovi.calorie_bruciate || 0))
    });
}

// PASTI SALVATI
async function salvaPastoTipico(nome, descrizione, calorie, proteine, carboidrati, grassi) {
    const nomeNorm = nome.toLowerCase().trim();
    await db.pastiTipici.put({
        nome: nomeNorm,
        descrizione: descrizione,
        calorie: calorie,
        proteine: proteine,
        carboidrati: carboidrati,
        grassi: grassi
    });
    console.log(`Pasto "${nomeNorm}" salvato!`);
}

async function eliminaPastoTipico(nome) {
    const conferma = confirm(`Eliminare il pasto "${nome}"?`);
    if (conferma) {
        await db.pastiTipici.delete(nome);
        caricaListaPasti();
    }
}

async function caricaListaPasti() {
    const container = document.getElementById('lista-pasti-salvati');
    const pasti = await db.pastiTipici.toArray();
    
    if (pasti.length === 0) {
        container.innerHTML = '<div class="nessun-pasto">Nessun pasto salvato.<br>Usa la chat per aggiungerne!</div>';
        return;
    }
    
    container.innerHTML = '';
    pasti.forEach(p => {
        const card = document.createElement('div');
        card.className = 'pasto-card';
        card.innerHTML = `
            <button class="btn-elimina-pasto">✕</button>
            <h4>${escapeHTML(p.nome)}</h4>
            <div class="pasto-desc">${escapeHTML(p.descrizione || 'Nessuna descrizione')}</div>
            <div class="pasto-macro">
                <span>🔥 ${p.calorie} kcal</span>
                <span>🥩 P: ${p.proteine}g</span>
                <span>🍞 C: ${p.carboidrati}g</span>
                <span>🧈 G: ${p.grassi}g</span>
            </div>
        `;
        card.querySelector('.btn-elimina-pasto').addEventListener('click', () => eliminaPastoTipico(p.nome));
        container.appendChild(card);
    });
}

function aggiungiMessaggio(m, t) {
    const c = document.getElementById("chat-box");
    const p = document.createElement("p");
    p.innerHTML = `<strong>${m}:</strong> ${escapeHTML(t).replace(/\n/g, "<br>")}`;
    c.appendChild(p);
    c.scrollTop = c.scrollHeight;
}

document.getElementById("user-input").addEventListener("keypress", (e) => { 
    if (e.key === "Enter" && !invioInCorso) inviaMessaggio(); 
});

// PROFILO FISICO
function calcolaBMR(peso, altezza, eta, sesso) {
    return sesso === 'M'
        ? (10 * peso) + (6.25 * altezza) - (5 * eta) + 5
        : (10 * peso) + (6.25 * altezza) - (5 * eta) - 161;
}

async function salvaProfilo() {
    const peso = parseFloat(document.getElementById('input-peso').value);
    const altezza = parseFloat(document.getElementById('input-altezza').value);
    const eta = parseInt(document.getElementById('input-eta').value);
    const sesso = document.getElementById('input-sesso').value;
    const fattoreAttivita = parseFloat(document.getElementById('input-attivita').value);

    if (!peso || !altezza || !eta) return alert("Compila tutti i campi!");

    localStorage.setItem('profilo_altezza', altezza);
    localStorage.setItem('profilo_eta', eta);
    localStorage.setItem('profilo_sesso', sesso);
    localStorage.setItem('profilo_attivita', fattoreAttivita);

    const bmr = calcolaBMR(peso, altezza, eta, sesso);
    const tdee = Math.round(bmr * fattoreAttivita);
    const bmi = peso / ((altezza / 100) * (altezza / 100));

    document.getElementById('risultato-profilo').innerHTML =
        `BMI: <strong>${bmi.toFixed(1)}</strong> | TDEE stimato: <strong>${tdee} kcal</strong>`;

    const oggi = ottieniData(0);
    const recordOggi = await db.diario.get(oggi) || { calorieMangiate: 0, proteine: 0, carbo: 0, grassi: 0, calorieBruciate: 0 };
    await db.diario.put({ ...recordOggi, data: oggi, peso, bmi: parseFloat(bmi.toFixed(1)), bmr, tdee });

    if (chartInstance || chartFisicoInstance) disegnaGrafico();
}

async function caricaProfiloInUI() {
    document.getElementById('input-altezza').value = localStorage.getItem('profilo_altezza') || '';
    document.getElementById('input-eta').value = localStorage.getItem('profilo_eta') || '';
    document.getElementById('input-sesso').value = localStorage.getItem('profilo_sesso') || 'M';
    const fattoreSalvato = localStorage.getItem('profilo_attivita');
    if (fattoreSalvato) document.getElementById('input-attivita').value = fattoreSalvato;

    const tutti = await db.diario.orderBy('data').reverse().toArray();
    const u = tutti.find(d => d.peso);
    if (u) {
        document.getElementById('input-peso').value = u.peso;
        document.getElementById('risultato-profilo').innerHTML =
            `BMI: <strong>${u.bmi ? u.bmi.toFixed(1) : '—'}</strong> | TDEE stimato: <strong>${Math.round(u.tdee)} kcal</strong>`;
    }
}

// NAVIGAZIONE
function aggiornaMenu(idAttivo) {
    document.querySelectorAll('.menu button').forEach(b => b.classList.remove('attivo'));
    document.getElementById(idAttivo).classList.add('attivo');
}

function mostraChat() {
    aggiornaMenu('btn-menu-chat');
    document.getElementById("chat-section").style.display = "block";
    document.getElementById("dashboard-box").style.display = "none";
    document.getElementById("pasti-salvati-box").style.display = "none";
}

function mostraDashboard() {
    aggiornaMenu('btn-menu-dashboard');
    document.getElementById("chat-section").style.display = "none";
    document.getElementById("dashboard-box").style.display = "block";
    document.getElementById("pasti-salvati-box").style.display = "none";
    caricaProfiloInUI();
    disegnaGrafico();
}

function mostraPastiSalvati() {
    aggiornaMenu('btn-menu-pasti');
    document.getElementById("chat-section").style.display = "none";
    document.getElementById("dashboard-box").style.display = "none";
    document.getElementById("pasti-salvati-box").style.display = "block";
    caricaListaPasti();
}

// DASHBOARD
let chartInstance = null, chartFisicoInstance = null;
let filtroAttuale = 'settimana', metricaAttuale = 'base', metricaFisicaAttuale = 'peso';

function setFiltroAttivo(contenitore, bottone) {
    // Rimuovi lo stile attivo solo dai bottoni con bg default (non quelli con colore custom)
    contenitore.querySelectorAll('button').forEach(b => {
        if (!b.style.backgroundColor) b.classList.remove('attivo');
    });
    if (!bottone.style.backgroundColor) bottone.classList.add('attivo');
}

function cambiaFiltro(n, btn) { 
    filtroAttuale = n; 
    document.querySelectorAll('#filtri-intervallo button').forEach(b => b.classList.remove('attivo'));
    if (btn) btn.classList.add('attivo');
    disegnaGrafico(); 
}

function cambiaMetrica(n, btn) { 
    metricaAttuale = n; 
    document.querySelectorAll('#filtri-metriche button').forEach(b => b.classList.remove('attivo'));
    if (btn) btn.classList.add('attivo');
    disegnaGrafico(); 
}

function cambiaMetricaFisica(n, btn) { 
    metricaFisicaAttuale = n; 
    document.querySelectorAll('#filtri-fisico button').forEach(b => b.classList.remove('attivo'));
    if (btn) btn.classList.add('attivo');
    disegnaGrafico(); 
}

async function disegnaGrafico() {
    const oggi = new Date();
    let dataInizio = new Date();
    if (filtroAttuale === 'settimana') dataInizio.setDate(oggi.getDate() - 7);
    else if (filtroAttuale === 'mese') dataInizio.setMonth(oggi.getMonth() - 1);

    const tuttiIDati = await db.diario.toArray();
    const datiFiltrati = tuttiIDati
        .filter(d => new Date(d.data) >= dataInizio)
        .sort((a, b) => new Date(a.data) - new Date(b.data));

    const labels = datiFiltrati.map(d => d.data);
    const fallbackTDEE = (await ottieniTDEEAttuale()) || 2300;

    let ds1 = [];
    if (metricaAttuale === 'base') {
        ds1 = [
            {
                label: 'Calorie mangiate',
                data: datiFiltrati.map(d => d.calorieMangiate || 0),
                borderColor: '#28a745',
                backgroundColor: 'rgba(40,167,69,0.1)',
                tension: 0.3,
                fill: true
            },
            {
                label: 'Target TDEE',
                data: datiFiltrati.map(d => (d.tdee || fallbackTDEE) + (d.calorieBruciate || 0)),
                borderColor: '#007bff',
                borderDash: [5, 5],
                tension: 0.3,
                fill: false
            }
        ];
    } else if (metricaAttuale === 'deficit') {
        ds1 = [{
            label: 'Bilancio calorico',
            data: datiFiltrati.map(d => (d.calorieMangiate || 0) - ((d.tdee || fallbackTDEE) + (d.calorieBruciate || 0))),
            borderColor: '#dc3545',
            backgroundColor: 'rgba(220,53,69,0.1)',
            tension: 0.3,
            fill: true
        }];
    } else {
        const chiave = metricaAttuale === 'carboidrati' ? 'carbo' : metricaAttuale;
        ds1 = [{
            label: metricaAttuale.charAt(0).toUpperCase() + metricaAttuale.slice(1) + ' (g)',
            data: datiFiltrati.map(d => d[chiave] || 0),
            borderColor: '#6f42c1',
            backgroundColor: 'rgba(111,66,193,0.1)',
            tension: 0.3,
            fill: true
        }];

        // Linea consigliata macro (se profilo disponibile)
        const ultimoPeso = [...tuttiIDati].reverse().find(d => d.peso);
        if (ultimoPeso && fallbackTDEE) {
            const peso = ultimoPeso.peso;
            const fattore = parseFloat(localStorage.getItem('profilo_attivita')) || 1.55;
            let valoreConsigliato = null;
            let etichetta = '';

            if (metricaAttuale === 'proteine') {
                // Da 0.8g/kg (sedentario) a 2.0g/kg (molto attivo)
                const gPerKg = fattore <= 1.2 ? 0.8 : fattore <= 1.375 ? 1.2 : fattore <= 1.55 ? 1.6 : 2.0;
                valoreConsigliato = Math.round(peso * gPerKg);
                etichetta = `Consigliato (~${gPerKg}g/kg)`;
            } else if (metricaAttuale === 'carboidrati') {
                // ~50% delle calorie / 4 kcal per grammo
                valoreConsigliato = Math.round(fallbackTDEE * 0.50 / 4);
                etichetta = 'Consigliato (~50% kcal)';
            } else if (metricaAttuale === 'grassi') {
                // ~25% delle calorie / 9 kcal per grammo
                valoreConsigliato = Math.round(fallbackTDEE * 0.25 / 9);
                etichetta = 'Consigliato (~25% kcal)';
            }

            if (valoreConsigliato) {
                ds1.push({
                    label: etichetta,
                    data: datiFiltrati.map(() => valoreConsigliato),
                    borderColor: '#007bff',
                    borderDash: [5, 5],
                    tension: 0.3,
                    fill: false,
                    pointRadius: 0
                });
            }
        }
    }

    const ctx1 = document.getElementById('graficoCalorie').getContext('2d');
    if (chartInstance) chartInstance.destroy();
    chartInstance = new Chart(ctx1, {
        type: 'line',
        data: { labels, datasets: ds1 },
        options: { responsive: true, plugins: { legend: { display: true } } }
    });

    // GRAFICO FISICO
    const datiFisici = datiFiltrati.filter(d => d[metricaFisicaAttuale] !== undefined);
    const ctx2 = document.getElementById('graficoFisico').getContext('2d');
    if (chartFisicoInstance) chartFisicoInstance.destroy();
    chartFisicoInstance = new Chart(ctx2, {
        type: 'line',
        data: {
            labels: datiFisici.map(d => d.data),
            datasets: [{
                label: metricaFisicaAttuale === 'peso' ? 'Peso (kg)' : 'BMI',
                data: datiFisici.map(d => d[metricaFisicaAttuale]),
                borderColor: metricaFisicaAttuale === 'peso' ? '#e83e8c' : '#6f42c1',
                backgroundColor: metricaFisicaAttuale === 'peso' ? 'rgba(232,62,140,0.1)' : 'rgba(111,66,193,0.1)',
                fill: true,
                tension: 0.3
            }]
        },
        options: { responsive: true }
    });
}

// EXPORT / IMPORT
async function esportaDati() {
    try {
        const diario = await db.diario.toArray();
        const pasti = await db.pastiTipici.toArray();
        
        const backup = {
            versione: 1,
            dataExport: new Date().toISOString(),
            diario,
            pastiTipici: pasti,
            profilo: {
                altezza: localStorage.getItem('profilo_altezza'),
                eta: localStorage.getItem('profilo_eta'),
                sesso: localStorage.getItem('profilo_sesso'),
                attivita: localStorage.getItem('profilo_attivita')
            }
        };
        
        const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `dietologo-backup-${ottieniData(0)}.json`;
        a.click();
        URL.revokeObjectURL(url);
        
        document.getElementById('stato-backup').textContent = `✓ Backup esportato (${diario.length} giorni, ${pasti.length} pasti)`;
    } catch (e) {
        alert('Errore durante l\'export: ' + e.message);
    }
}

async function importaDati(input) {
    const file = input.files[0];
    if (!file) return;
    
    const conferma = confirm('L\'importazione sovrascriverà i dati esistenti con quelli del backup. Continuare?');
    if (!conferma) { input.value = ''; return; }
    
    try {
        const testo = await file.text();
        const backup = JSON.parse(testo);
        
        if (!backup.diario || !backup.pastiTipici) {
            throw new Error('File non valido: mancano le tabelle diario o pastiTipici.');
        }
        
        // Ripristina diario
        await db.diario.clear();
        if (backup.diario.length > 0) await db.diario.bulkPut(backup.diario);
        
        // Ripristina pasti
        await db.pastiTipici.clear();
        if (backup.pastiTipici.length > 0) await db.pastiTipici.bulkPut(backup.pastiTipici);
        
        // Ripristina profilo
        if (backup.profilo) {
            if (backup.profilo.altezza) localStorage.setItem('profilo_altezza', backup.profilo.altezza);
            if (backup.profilo.eta) localStorage.setItem('profilo_eta', backup.profilo.eta);
            if (backup.profilo.sesso) localStorage.setItem('profilo_sesso', backup.profilo.sesso);
            if (backup.profilo.attivita) localStorage.setItem('profilo_attivita', backup.profilo.attivita);
        }
        
        document.getElementById('stato-backup').textContent = `✓ Importati ${backup.diario.length} giorni e ${backup.pastiTipici.length} pasti`;
        caricaProfiloInUI();
        disegnaGrafico();
    } catch (e) {
        alert('Errore durante l\'import: ' + e.message);
    }
    input.value = '';
}
