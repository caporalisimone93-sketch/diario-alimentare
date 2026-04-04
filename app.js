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

db.version(4).stores({
    pastiTipici: 'nome',
    diario: 'data',
    pasti: '++id, data, tipo'
}).upgrade(async tx => {
    const records = await tx.table('diario').toArray();
    for (const r of records) {
        if ((r.calorieMangiate || 0) > 0) {
            await tx.table('pasti').add({
                data: r.data,
                tipo: 'importato',
                calorie: r.calorieMangiate || 0,
                proteine: r.proteine || 0,
                carboidrati: r.carbo || 0,
                grassi: r.grassi || 0
            });
        }
        await tx.table('diario').update(r.data, {
            calorieMangiate: 0, proteine: 0, carbo: 0, grassi: 0
        });
    }
});

const TIPI_PASTO_SINGOLI = ['colazione', 'pranzo', 'merenda', 'cena'];
const TIPI_PASTO_TUTTI = [...TIPI_PASTO_SINGOLI, 'spuntino'];

// PROTEZIONE XSS
function escapeHTML(str) {
    const p = document.createElement('p');
    p.textContent = str;
    return p.innerHTML;
}

// CRONOLOGIA CHAT
let cronologiaChat = [];
const MAX_MESSAGGI_CONTESTO = 10;

function aggiungiACronologia(ruolo, testo) {
    cronologiaChat.push({ role: ruolo, parts: [{ text: testo }] });
    if (cronologiaChat.length > MAX_MESSAGGI_CONTESTO) {
        cronologiaChat = cronologiaChat.slice(-MAX_MESSAGGI_CONTESTO);
    }
}

// STATO INVIO
let invioInCorso = false;

function bloccaInvio() {
    invioInCorso = true;
    document.getElementById('btn-invia').disabled = true;
    document.getElementById('btn-invia').textContent = '...';
    document.getElementById('user-input').disabled = true;
    document.getElementById('btn-foto').disabled = true;
}

function sbloccaInvio() {
    invioInCorso = false;
    document.getElementById('btn-invia').disabled = false;
    document.getElementById('btn-invia').textContent = 'Invia';
    document.getElementById('user-input').disabled = false;
    document.getElementById('btn-foto').disabled = false;
    document.getElementById('user-input').focus();
}

// GESTIONE FOTO
let fotoAllegata = null;

function anteprimaFoto(input) {
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
            const MAX = 1024;
            let w = img.width, h = img.height;
            if (w > MAX || h > MAX) {
                if (w > h) { h = Math.round(h * MAX / w); w = MAX; }
                else { w = Math.round(w * MAX / h); h = MAX; }
            }
            const canvas = document.createElement('canvas');
            canvas.width = w; canvas.height = h;
            canvas.getContext('2d').drawImage(img, 0, 0, w, h);
            const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
            fotoAllegata = { base64: dataUrl.split(',')[1], mimeType: 'image/jpeg' };
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

// UTILITÀ DATE
function ottieniData(giorniIndietro = 0) {
    const d = new Date();
    d.setDate(d.getDate() - giorniIndietro);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function ottieniTDEEAttuale() {
    const tuttiIDati = await db.diario.orderBy('data').reverse().toArray();
    const record = tuttiIDati.find(d => d.tdee);
    return record ? record.tdee : null;
}

// AGGREGAZIONE PASTI
async function ottieniPastiGiorno(data) {
    return await db.pasti.where('data').equals(data).toArray();
}

function sommaPasti(lista) {
    return lista.reduce((t, p) => ({
        calorie: t.calorie + (p.calorie || 0),
        proteine: t.proteine + (p.proteine || 0),
        carboidrati: t.carboidrati + (p.carboidrati || 0),
        grassi: t.grassi + (p.grassi || 0)
    }), { calorie: 0, proteine: 0, carboidrati: 0, grassi: 0 });
}

function formattaPastiPerPrompt(lista) {
    if (lista.length === 0) return 'Nessun pasto registrato.';
    const righe = [];
    for (const tipo of [...TIPI_PASTO_TUTTI, 'importato']) {
        const entries = lista.filter(p => p.tipo === tipo);
        for (const e of entries) {
            righe.push(`- ${tipo}: ${e.calorie}kcal P:${e.proteine}g C:${e.carboidrati}g G:${e.grassi}g`);
        }
    }
    return righe.join('\n');
}

async function ottieniTotaliGiornalieri() {
    const tuttiIPasti = await db.pasti.toArray();
    const tuttiIDiario = await db.diario.toArray();

    const perGiorno = {};
    for (const p of tuttiIPasti) {
        if (!perGiorno[p.data]) perGiorno[p.data] = { calorie: 0, proteine: 0, carbo: 0, grassi: 0 };
        perGiorno[p.data].calorie += p.calorie || 0;
        perGiorno[p.data].proteine += p.proteine || 0;
        perGiorno[p.data].carbo += p.carboidrati || 0;
        perGiorno[p.data].grassi += p.grassi || 0;
    }

    const tutteLeDate = new Set([...Object.keys(perGiorno), ...tuttiIDiario.map(d => d.data)]);
    const risultato = [];
    for (const data of tutteLeDate) {
        const cibo = perGiorno[data] || { calorie: 0, proteine: 0, carbo: 0, grassi: 0 };
        const diario = tuttiIDiario.find(d => d.data === data) || {};
        risultato.push({
            data,
            calorieMangiate: cibo.calorie,
            proteine: cibo.proteine,
            carbo: cibo.carbo,
            grassi: cibo.grassi,
            calorieBruciate: diario.calorieBruciate || 0,
            tdee: diario.tdee, peso: diario.peso, bmi: diario.bmi
        });
    }
    return risultato;
}

// RESET
async function resetDatiGiorno(giorniIndietro) {
    const dataTarget = ottieniData(giorniIndietro);
    const label = giorniIndietro === 0 ? 'OGGI' : 'IERI';
    if (!confirm(`Vuoi davvero azzerare tutti i pasti e l'allenamento di ${label} (${dataTarget})?`)) return;

    await db.pasti.where('data').equals(dataTarget).delete();
    const record = await db.diario.get(dataTarget);
    if (record) await db.diario.update(dataTarget, { calorieBruciate: 0 });

    alert("Dati resettati!");
    if (document.getElementById("dashboard-box").style.display === "block") disegnaGrafico();
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

    const loadingMsg = document.createElement("p");
    loadingMsg.innerHTML = `<strong>Dietologo:</strong> <span class="loading-dots">Sto pensando</span>`;
    chatBox.appendChild(loadingMsg);
    chatBox.scrollTop = chatBox.scrollHeight;

    try {
        const risultato = await faiDomandaAGemini(testoUtente || "Analizza questa foto", apiKey, foto);
        let html = `<strong>Dietologo:</strong> ${escapeHTML(risultato.testo).replace(/\n/g, "<br>")}`;

        if (risultato.conferma) {
            const c = risultato.conferma;
            if (c.calorie || c.bruciate) {
                const parti = [];
                if (c.calorie) parti.push(`${c.calorie} kcal`);
                if (c.p) parti.push(`P ${c.p}g`);
                if (c.c) parti.push(`C ${c.c}g`);
                if (c.g) parti.push(`G ${c.g}g`);
                if (c.bruciate) parti.push(`🏃 -${c.bruciate} kcal`);
                const giorno = c.data !== ottieniData(0) ? ` (${c.data})` : '';
                const tipoLabel = c.tipo ? c.tipo.charAt(0).toUpperCase() + c.tipo.slice(1) : 'Registrato';
                html += `<div class="conferma-registrazione">✓ ${escapeHTML(tipoLabel)}${giorno}: ${parti.join(' | ')}</div>`;
            }
            if (c.pastoSalvato) {
                html += `<div class="conferma-pasto-salvato">✓ "${escapeHTML(c.pastoSalvato)}" salvato nei preferiti</div>`;
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

    const pastiOggi = await ottieniPastiGiorno(dataOggi);
    const pastiIeri = await ottieniPastiGiorno(dataIeri);
    const totOggi = sommaPasti(pastiOggi);
    const totIeri = sommaPasti(pastiIeri);

    const recordOggi = await db.diario.get(dataOggi) || {};
    const recordIeri = await db.diario.get(dataIeri) || {};

    const pastiSalvati = await db.pastiTipici.toArray();
    let memoriaPasti = pastiSalvati.length > 0
        ? "Alimenti/pasti salvati: " + pastiSalvati.map(p =>
            `"${p.nome}" = ${p.descrizione} (${p.calorie}kcal, P:${p.proteine}g C:${p.carboidrati}g G:${p.grassi}g)`
          ).join("; ")
        : "Nessun alimento/pasto salvato.";

    const tdeeAttuale = await ottieniTDEEAttuale();
    const tdeeInfo = tdeeAttuale ? `TDEE: ${Math.round(tdeeAttuale)} kcal.` : "TDEE non configurato.";

    const totali = await ottieniTotaliGiornalieri();
    const trentaGiorniFa = new Date();
    trentaGiorniFa.setDate(trentaGiorniFa.getDate() - 30);
    const storico = totali
        .filter(d => new Date(d.data) >= trentaGiorniFa)
        .sort((a, b) => a.data.localeCompare(b.data))
        .map(d => `${d.data}: ${d.calorieMangiate}kcal P:${d.proteine}g C:${d.carbo}g G:${d.grassi}g bruciato:${d.calorieBruciate}kcal${d.tdee ? ' TDEE:'+d.tdee : ''}${d.peso ? ' peso:'+d.peso+'kg' : ''}`)
        .join('\n');

    const systemInstruction = `Sei un dietologo sintetico in un'app di tracking calorico.

REGOLE:
1. Capisci se l'utente parla di OGGI (${dataOggi}) o di IERI (${dataIeri}).
2. Rispondi con analisi del pasto/allenamento e commento tecnico brevissimo.
3. ${memoriaPasti}
4. ${tdeeInfo}

PASTI REGISTRATI OGGI (${dataOggi}):
${formattaPastiPerPrompt(pastiOggi)}
Totale oggi: ${totOggi.calorie} kcal mangiate | Bruciato: ${recordOggi.calorieBruciate || 0} kcal

PASTI REGISTRATI IERI (${dataIeri}):
${formattaPastiPerPrompt(pastiIeri)}
Totale ieri: ${totIeri.calorie} kcal mangiate | Bruciato: ${recordIeri.calorieBruciate || 0} kcal

STORICO (ultimi 30 giorni):
${storico || 'Nessun dato.'}

RISPOSTE ANALITICHE: per domande su totali, medie o trend, USA SEMPRE i dati registrati qui sopra. NON ricalcolare. Dai solo il risultato finale.

TIPO DI PASTO (IMPORTANTE):
Ogni registrazione DEVE avere un tipo_pasto: "colazione", "pranzo", "merenda", "cena" o "spuntino".
- Deduci dal contesto ("stamattina"→colazione, "a pranzo"→pranzo, "per merenda"→merenda, "stasera"/"a cena"→cena).
- Se non è chiaro, CHIEDI all'utente.
- colazione/pranzo/merenda/cena: UNA SOLA VOLTA al giorno. Se già presente, i nuovi valori SOSTITUISCONO i vecchi.
- spuntino: può essere registrato PIÙ VOLTE, ogni spuntino si AGGIUNGE.

ALIMENTI/PASTI SALVATI:
- Se l'utente menziona un alimento salvato, USA i valori salvati.
- VALORI PER 100g: se la descrizione dice "per 100g", chiedi quantità o calcola proporzionalmente.
- COMPOSIZIONE da salvati: SOMMA i valori esatti, non stimare.
- SALVATAGGIO: aggiungi "salva_pasto" nel JSON.
- AGGIORNAMENTO: salva con stesso nome per sovrascrivere.
- SOLO SALVATAGGIO senza registrare: metti valori a 0 nel JSON principale.

CORREZIONI:
- colazione/pranzo/merenda/cena: basta ridire il pasto, viene sostituito.
- spuntino: usa valori negativi per togliere.
- esercizio: usa calorie_bruciate negative.

Formato JSON alla fine della risposta:
\`\`\`json
{
  "data_riferimento": "${dataOggi}",
  "tipo_pasto": "pranzo",
  "calorie": 0,
  "proteine": 0,
  "carboidrati": 0,
  "grassi": 0,
  "calorie_bruciate": 0,
  "salva_pasto": null
}
\`\`\`

Per salvare un alimento:
\`\`\`json
"salva_pasto": { "nome": "nome", "descrizione": "desc", "calorie": 0, "proteine": 0, "carboidrati": 0, "grassi": 0 }
\`\`\`

Se il messaggio è una domanda generica o analitica, rispondi SENZA JSON.

FOTO: leggi immagini di etichette (valori esatti) o cibo (stima).`;

    const userParts = [];
    if (foto) userParts.push({ inline_data: { mime_type: foto.mimeType, data: foto.base64 } });
    userParts.push({ text: testo });

    aggiungiACronologia("user", foto ? `[foto allegata] ${testo}` : testo);

    const contenutiPrecedenti = cronologiaChat.slice(0, -1);
    const requestBody = {
        system_instruction: { parts: [{ text: systemInstruction }] },
        contents: [...contenutiPrecedenti, { role: "user", parts: userParts }]
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

    aggiungiACronologia("model", testoRisposta);

    let conferma = null;
    try {
        const jsonMatch = testoRisposta.match(/```(?:json|JSON)?\s*\n?([\s\S]*?)```/);
        if (jsonMatch) {
            const dati = JSON.parse(jsonMatch[1].trim());
            const tipoPasto = (dati.tipo_pasto || '').toLowerCase().trim();
            const dataRif = dati.data_riferimento || dataOggi;

            if (dati.calorie || dati.proteine || dati.carboidrati || dati.grassi) {
                await registraPasto(dataRif, tipoPasto, dati);
                conferma = {
                    calorie: dati.calorie || 0, p: dati.proteine || 0,
                    c: dati.carboidrati || 0, g: dati.grassi || 0,
                    bruciate: 0, data: dataRif, tipo: tipoPasto
                };
            }

            if (dati.calorie_bruciate) {
                await registraEsercizio(dataRif, dati.calorie_bruciate);
                conferma = conferma || { data: dataRif };
                conferma.bruciate = dati.calorie_bruciate;
            }

            if (dati.salva_pasto && dati.salva_pasto.nome) {
                const sp = dati.salva_pasto;
                await salvaPastoTipico(
                    sp.nome, sp.descrizione || '',
                    sp.calorie || dati.calorie || 0, sp.proteine || dati.proteine || 0,
                    sp.carboidrati || dati.carboidrati || 0, sp.grassi || dati.grassi || 0
                );
                conferma = conferma || {};
                conferma.pastoSalvato = sp.nome;
            }
        }
    } catch (e) { console.error("Errore parsing JSON:", e); }

    const testoPulito = testoRisposta.replace(/```(?:json|JSON)?\s*\n?[\s\S]*?```/g, '').trim();
    return { testo: testoPulito, conferma };
}

// REGISTRAZIONE PASTO
async function registraPasto(data, tipo, dati) {
    const pasto = {
        data,
        tipo: tipo || 'spuntino',
        calorie: dati.calorie || 0,
        proteine: dati.proteine || 0,
        carboidrati: dati.carboidrati || 0,
        grassi: dati.grassi || 0
    };

    if (TIPI_PASTO_SINGOLI.includes(pasto.tipo)) {
        // Colazione/pranzo/merenda/cena: cancella il vecchio, metti il nuovo
        await db.pasti.where({ data, tipo: pasto.tipo }).delete();
        pasto.calorie = Math.max(0, pasto.calorie);
        pasto.proteine = Math.max(0, pasto.proteine);
        pasto.carboidrati = Math.max(0, pasto.carboidrati);
        pasto.grassi = Math.max(0, pasto.grassi);
    }

    await db.pasti.add(pasto);
}

// REGISTRAZIONE ESERCIZIO
async function registraEsercizio(data, calorieBruciate) {
    const record = await db.diario.get(data) || {};
    await db.diario.put({
        ...record, data,
        calorieBruciate: Math.max(0, (record.calorieBruciate || 0) + calorieBruciate)
    });
}

// PASTI SALVATI (database alimenti)
async function salvaPastoTipico(nome, descrizione, calorie, proteine, carboidrati, grassi) {
    await db.pastiTipici.put({
        nome: nome.toLowerCase().trim(), descrizione, calorie, proteine, carboidrati, grassi
    });
}

async function eliminaPastoTipico(nome) {
    if (!confirm(`Eliminare "${nome}"?`)) return;
    await db.pastiTipici.delete(nome);
    caricaListaPasti();
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

        // Vista normale
        const vistanormale = document.createElement('div');
        vistanormale.className = 'pasto-vista-normale';
        vistanormale.innerHTML = `
            <div class="pasto-card-actions">
                <button class="btn-modifica-pasto">✏️</button>
                <button class="btn-elimina-pasto">✕</button>
            </div>
            <h4>${escapeHTML(p.nome)}</h4>
            <div class="pasto-desc">${escapeHTML(p.descrizione || 'Nessuna descrizione')}</div>
            <div class="pasto-macro">
                <span>🔥 ${p.calorie} kcal</span>
                <span>🥩 P: ${p.proteine}g</span>
                <span>🍞 C: ${p.carboidrati}g</span>
                <span>🧈 G: ${p.grassi}g</span>
            </div>
        `;

        // Vista modifica
        const vistaModifica = document.createElement('div');
        vistaModifica.className = 'pasto-vista-modifica';
        vistaModifica.style.display = 'none';
        vistaModifica.innerHTML = `
            <input type="text" class="edit-nome" value="${escapeHTML(p.nome)}" placeholder="Nome">
            <input type="text" class="edit-desc" value="${escapeHTML(p.descrizione || '')}" placeholder="Descrizione">
            <div class="edit-macro-grid">
                <input type="number" class="edit-kcal" value="${p.calorie}" placeholder="kcal" step="1">
                <input type="number" class="edit-pro" value="${p.proteine}" placeholder="P (g)" step="0.1">
                <input type="number" class="edit-carbo" value="${p.carboidrati}" placeholder="C (g)" step="0.1">
                <input type="number" class="edit-grassi" value="${p.grassi}" placeholder="G (g)" step="0.1">
            </div>
            <div class="edit-actions">
                <button class="btn-edit-salva">Salva</button>
                <button class="btn-edit-annulla">Annulla</button>
            </div>
        `;

        card.appendChild(vistanormale);
        card.appendChild(vistaModifica);

        // Eventi
        vistanormale.querySelector('.btn-elimina-pasto').addEventListener('click', () => eliminaPastoTipico(p.nome));
        vistanormale.querySelector('.btn-modifica-pasto').addEventListener('click', () => {
            vistanormale.style.display = 'none';
            vistaModifica.style.display = 'block';
        });
        vistaModifica.querySelector('.btn-edit-annulla').addEventListener('click', () => {
            vistaModifica.style.display = 'none';
            vistanormale.style.display = 'block';
        });
        vistaModifica.querySelector('.btn-edit-salva').addEventListener('click', async () => {
            const nuovoNome = vistaModifica.querySelector('.edit-nome').value.trim().toLowerCase();
            if (!nuovoNome) return alert('Inserisci un nome.');

            // Se il nome è cambiato, cancella il vecchio
            if (nuovoNome !== p.nome) {
                await db.pastiTipici.delete(p.nome);
            }

            await db.pastiTipici.put({
                nome: nuovoNome,
                descrizione: vistaModifica.querySelector('.edit-desc').value.trim(),
                calorie: parseFloat(vistaModifica.querySelector('.edit-kcal').value) || 0,
                proteine: parseFloat(vistaModifica.querySelector('.edit-pro').value) || 0,
                carboidrati: parseFloat(vistaModifica.querySelector('.edit-carbo').value) || 0,
                grassi: parseFloat(vistaModifica.querySelector('.edit-grassi').value) || 0
            });
            caricaListaPasti();
        });

        container.appendChild(card);
    });
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
    const record = await db.diario.get(oggi) || {};
    await db.diario.put({ ...record, data: oggi, peso, bmi: parseFloat(bmi.toFixed(1)), bmr, tdee });

    if (chartInstance || chartFisicoInstance) disegnaGrafico();
}

async function caricaProfiloInUI() {
    document.getElementById('input-altezza').value = localStorage.getItem('profilo_altezza') || '';
    document.getElementById('input-eta').value = localStorage.getItem('profilo_eta') || '';
    document.getElementById('input-sesso').value = localStorage.getItem('profilo_sesso') || 'M';
    const f = localStorage.getItem('profilo_attivita');
    if (f) document.getElementById('input-attivita').value = f;

    const tutti = await db.diario.orderBy('data').reverse().toArray();
    const u = tutti.find(d => d.peso);
    if (u) {
        document.getElementById('input-peso').value = u.peso;
        document.getElementById('risultato-profilo').innerHTML =
            `BMI: <strong>${u.bmi ? u.bmi.toFixed(1) : '—'}</strong> | TDEE stimato: <strong>${Math.round(u.tdee)} kcal</strong>`;
    }
}

// NAVIGAZIONE
function aggiornaMenu(id) {
    document.querySelectorAll('.menu button').forEach(b => b.classList.remove('attivo'));
    document.getElementById(id).classList.add('attivo');
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

    const tuttiIDati = await ottieniTotaliGiornalieri();
    const datiFiltrati = tuttiIDati
        .filter(d => new Date(d.data) >= dataInizio)
        .sort((a, b) => new Date(a.data) - new Date(b.data));

    const labels = datiFiltrati.map(d => d.data);
    const fallbackTDEE = (await ottieniTDEEAttuale()) || 2300;

    let ds1 = [];
    if (metricaAttuale === 'base') {
        ds1 = [
            { label: 'Calorie mangiate', data: datiFiltrati.map(d => d.calorieMangiate || 0), borderColor: '#28a745', backgroundColor: 'rgba(40,167,69,0.1)', tension: 0.3, fill: true },
            { label: 'Target TDEE', data: datiFiltrati.map(d => (d.tdee || fallbackTDEE) + (d.calorieBruciate || 0)), borderColor: '#007bff', borderDash: [5, 5], tension: 0.3, fill: false }
        ];
    } else if (metricaAttuale === 'deficit') {
        ds1 = [{ label: 'Bilancio calorico', data: datiFiltrati.map(d => (d.calorieMangiate || 0) - ((d.tdee || fallbackTDEE) + (d.calorieBruciate || 0))), borderColor: '#dc3545', backgroundColor: 'rgba(220,53,69,0.1)', tension: 0.3, fill: true }];
    } else {
        const chiave = metricaAttuale === 'carboidrati' ? 'carbo' : metricaAttuale;
        ds1 = [{ label: metricaAttuale.charAt(0).toUpperCase() + metricaAttuale.slice(1) + ' (g)', data: datiFiltrati.map(d => d[chiave] || 0), borderColor: '#6f42c1', backgroundColor: 'rgba(111,66,193,0.1)', tension: 0.3, fill: true }];

        const ultimoPeso = [...tuttiIDati].reverse().find(d => d.peso);
        if (ultimoPeso && fallbackTDEE) {
            const peso = ultimoPeso.peso;
            const fattore = parseFloat(localStorage.getItem('profilo_attivita')) || 1.55;
            let val = null, label = '';

            if (metricaAttuale === 'proteine') {
                const g = fattore <= 1.2 ? 0.8 : fattore <= 1.375 ? 1.2 : fattore <= 1.55 ? 1.6 : 2.0;
                val = Math.round(peso * g);
                label = `Consigliato (~${g}g/kg)`;
            } else if (metricaAttuale === 'carboidrati') {
                val = Math.round(fallbackTDEE * 0.50 / 4);
                label = 'Consigliato (~50% kcal)';
            } else if (metricaAttuale === 'grassi') {
                val = Math.round(fallbackTDEE * 0.25 / 9);
                label = 'Consigliato (~25% kcal)';
            }

            if (val) ds1.push({ label, data: datiFiltrati.map(() => val), borderColor: '#007bff', borderDash: [5, 5], tension: 0.3, fill: false, pointRadius: 0 });
        }
    }

    const ctx1 = document.getElementById('graficoCalorie').getContext('2d');
    if (chartInstance) chartInstance.destroy();
    chartInstance = new Chart(ctx1, { type: 'line', data: { labels, datasets: ds1 }, options: { responsive: true, plugins: { legend: { display: true } } } });

    const datiFisici = datiFiltrati.filter(d => d[metricaFisicaAttuale] !== undefined);
    const ctx2 = document.getElementById('graficoFisico').getContext('2d');
    if (chartFisicoInstance) chartFisicoInstance.destroy();
    chartFisicoInstance = new Chart(ctx2, {
        type: 'line',
        data: { labels: datiFisici.map(d => d.data), datasets: [{ label: metricaFisicaAttuale === 'peso' ? 'Peso (kg)' : 'BMI', data: datiFisici.map(d => d[metricaFisicaAttuale]), borderColor: metricaFisicaAttuale === 'peso' ? '#e83e8c' : '#6f42c1', backgroundColor: metricaFisicaAttuale === 'peso' ? 'rgba(232,62,140,0.1)' : 'rgba(111,66,193,0.1)', fill: true, tension: 0.3 }] },
        options: { responsive: true }
    });
}

// EXPORT / IMPORT
async function esportaDati() {
    try {
        const backup = {
            versione: 2,
            dataExport: new Date().toISOString(),
            diario: await db.diario.toArray(),
            pasti: await db.pasti.toArray(),
            pastiTipici: await db.pastiTipici.toArray(),
            profilo: {
                altezza: localStorage.getItem('profilo_altezza'),
                eta: localStorage.getItem('profilo_eta'),
                sesso: localStorage.getItem('profilo_sesso'),
                attivita: localStorage.getItem('profilo_attivita')
            }
        };

        const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `dietologo-backup-${ottieniData(0)}.json`;
        a.click();
        URL.revokeObjectURL(a.href);

        document.getElementById('stato-backup').textContent = `✓ Backup esportato (${backup.pasti.length} pasti, ${backup.pastiTipici.length} alimenti)`;
    } catch (e) { alert('Errore export: ' + e.message); }
}

async function importaDati(input) {
    const file = input.files[0];
    if (!file) return;
    if (!confirm('L\'importazione sovrascriverà i dati esistenti. Continuare?')) { input.value = ''; return; }

    try {
        const backup = JSON.parse(await file.text());

        if (backup.diario) {
            await db.diario.clear();
            await db.diario.bulkPut(backup.diario);
        }

        await db.pasti.clear();
        if (backup.versione >= 2 && backup.pasti) {
            await db.pasti.bulkPut(backup.pasti);
        } else if (backup.diario) {
            for (const r of backup.diario) {
                if ((r.calorieMangiate || 0) > 0) {
                    await db.pasti.add({ data: r.data, tipo: 'importato', calorie: r.calorieMangiate || 0, proteine: r.proteine || 0, carboidrati: r.carbo || 0, grassi: r.grassi || 0 });
                }
            }
        }

        if (backup.pastiTipici) {
            await db.pastiTipici.clear();
            await db.pastiTipici.bulkPut(backup.pastiTipici);
        }

        if (backup.profilo) {
            for (const [k, v] of Object.entries(backup.profilo)) {
                if (v) localStorage.setItem('profilo_' + k, v);
            }
        }

        document.getElementById('stato-backup').textContent = `✓ Importati ${await db.pasti.count()} pasti, ${await db.pastiTipici.count()} alimenti`;
        caricaProfiloInUI();
        disegnaGrafico();
    } catch (e) { alert('Errore import: ' + e.message); }
    input.value = '';
}
