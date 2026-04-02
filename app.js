// REGISTRAZIONE SERVICE WORKER (PWA)
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js')
      .then(() => console.log("Service Worker Registrato"))
      .catch(err => console.log("Errore SW:", err));
}

// CONFIGURAZIONE API - Usiamo ESATTAMENTE il modello della tua guida curl
const API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent";

function salvaApiKey() {
    const keyInput = document.getElementById('api-key-input');
    const key = keyInput.value.trim();
    if (key) {
        localStorage.setItem('gemini_api_key', key);
        alert("Chiave API salvata localmente!");
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
db.version(2).stores({
    pastiTipici: 'nome, descrizione, calorie, proteine, carboidrati, grassi',
    diario: 'data, calorieMangiate, proteine, carbo, grassi, calorieBruciate'
});

db.on('populate', function() {
    db.pastiTipici.add({
        nome: 'colazione di sempre',
        descrizione: '250gr yogurt greco, crema nocciole, agave, 25gr cereali',
        calorie: 305, proteine: 27.5, carboidrati: 35.5, grassi: 4.5
    });
});

// PROTEZIONE XSS
function escapeHTML(str) {
    const p = document.createElement('p');
    p.textContent = str;
    return p.innerHTML;
}

// UTILITY DATE
function ottieniData(giorniIndietro = 0) {
    const d = new Date();
    d.setDate(d.getDate() - giorniIndietro);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function ottieniTDEEAttuale() {
    const tuttiIDati = await db.diario.orderBy('data').reverse().toArray();
    const recordConTDEE = tuttiIDati.find(d => d.tdee);
    return recordConTDEE ? recordConTDEE.tdee : 2300; 
}

// LOGICA CHAT
async function inviaMessaggio() {
    const inputField = document.getElementById("user-input");
    const testoUtente = inputField.value.trim();
    if (!testoUtente) return; 

    const apiKey = ottieniApiKey();
    if (!apiKey) {
        alert("Inserisci la API Key nella sezione sotto!");
        return;
    }

    aggiungiMessaggio("Tu", testoUtente);
    inputField.value = ""; 
    aggiungiMessaggio("Dietologo", "...");

    try {
        const risposta = await faiDomandaAGemini(testoUtente, apiKey);
        const chatBox = document.getElementById("chat-box");
        // Rimuoviamo il blocco JSON dal testo mostrato all'utente
        const testoSenzaJson = risposta.replace(/```json[\s\S]*?```/g, "").trim();
        chatBox.lastElementChild.innerHTML = `<strong>Dietologo:</strong> ${testoSenzaJson || "Ho aggiornato i tuoi dati."}`;
    } catch (error) {
        document.getElementById("chat-box").lastElementChild.innerHTML = `<strong>Errore:</strong> ${escapeHTML(error.message)}`;
    }
}

async function faiDomandaAGemini(testo, apiKey) {
    const dataOggi = ottieniData(0);
    const dataIeri = ottieniData(1);
    
    const recordOggi = await db.diario.get(dataOggi) || { calorieMangiate: 0, calorieBruciate: 0 };
    const recordIeri = await db.diario.get(dataIeri) || { calorieMangiate: 0, calorieBruciate: 0 };
    const pastiSalvati = await db.pastiTipici.toArray();
    
    let memoriaPasti = "Pasti salvati: " + pastiSalvati.map(p => `"${p.nome}"`).join(", ");
    const tdee = await ottieniTDEEAttuale();

    const promptSistema = `Sei un dietologo. Analizza l'input.
OGGI: ${dataOggi}, IERI: ${dataIeri}.
Dati attuali: OGGI ${recordOggi.calorieMangiate}kcal, IERI ${recordIeri.calorieMangiate}kcal. TDEE: ${tdee}.
${memoriaPasti}.

Rispondi brevemente e DEVI includere questo JSON per aggiornare il DB:
\`\`\`json
{"data_riferimento": "${dataOggi}", "calorie_mangiate": 0, "proteine": 0, "carboidrati": 0, "grassi": 0, "calorie_bruciate": 0}
\`\`\``;

    const body = {
        contents: [{ parts: [{ text: `${promptSistema}\n\nUser: ${testo}` }] }]
    };

    // La chiave viene passata nell'Header come richiesto dalla tua guida curl
    const response = await fetch(API_URL, {
        method: "POST",
        headers: { 
            "Content-Type": "application/json",
            "X-Goog-Api-Key": apiKey 
        },
        body: JSON.stringify(body)
    });

    const data = await response.json();
    if (!response.ok) {
        throw new Error(data.error?.message || "Errore API");
    }
    
    const outputAI = data.candidates[0].content.parts[0].text;

    // Parsing JSON per aggiornare Dexie
    try {
        const match = outputAI.match(/```json([\s\S]*?)```/);
        if (match) {
            const dati = JSON.parse(match[1].trim());
            await aggiornaDiario(dati);
        }
    } catch(e) { console.error("Errore parsing dati AI", e); }

    return outputAI;
}

async function aggiornaDiario(dati) {
    const dataT = dati.data_riferimento || ottieniData(0);
    const r = await db.diario.get(dataT) || { calorieMangiate: 0, proteine: 0, carbo: 0, grassi: 0, calorieBruciate: 0 };
    
    await db.diario.put({
        ...r,
        data: dataT,
        calorieMangiate: (r.calorieMangiate || 0) + (dati.calorie_mangiate || 0),
        proteine: (r.proteine || 0) + (dati.proteine || 0),
        carbo: (r.carboidrati || 0) + (dati.carboidrati || 0),
        grassi: (r.grassi || 0) + (dati.grassi || 0),
        calorieBruciate: (r.calorieBruciate || 0) + (dati.calorie_bruciate || 0)
    });
}

function aggiungiMessaggio(m, t) {
    const c = document.getElementById("chat-box");
    const p = document.createElement("p");
    p.innerHTML = `<strong>${m}:</strong> ${t.replace(/\n/g, "<br>")}`;
    c.appendChild(p);
    c.scrollTop = c.scrollHeight;
}

// Evento Invio
document.getElementById("user-input").addEventListener("keypress", (e) => { if (e.key === "Enter") inviaMessaggio(); });

// PROFILO FISICO E DASHBOARD (Stessa logica di prima)
function calcolaBMR(p, a, e, s) {
    return s === 'M' ? (10 * p) + (6.25 * a) - (5 * e) + 5 : (10 * p) + (6.25 * a) - (5 * e) - 161;
}

async function salvaProfilo() {
    const p = parseFloat(document.getElementById('input-peso').value);
    const a = parseFloat(document.getElementById('input-altezza').value);
    const e = parseInt(document.getElementById('input-eta').value);
    const s = document.getElementById('input-sesso').value;
    if(!p || !a || !e) return alert("Compila tutto!");

    const bmr = calcolaBMR(p, a, e, s);
    const tdee = bmr * 1.2;
    localStorage.setItem('profilo_altezza', a);
    localStorage.setItem('profilo_eta', e);
    localStorage.setItem('profilo_sesso', s);

    const oggi = ottieniData(0);
    const rOggi = await db.diario.get(oggi) || { calorieMangiate: 0, proteine: 0, carbo: 0, grassi: 0, calorieBruciate: 0 };
    await db.diario.put({ ...rOggi, data: oggi, peso: p, bmi: p/((a/100)**2), bmr, tdee });
    alert("Profilo aggiornato!");
}

async function caricaProfiloInUI() {
    document.getElementById('input-altezza').value = localStorage.getItem('profilo_altezza') || '';
    document.getElementById('input-eta').value = localStorage.getItem('profilo_eta') || '';
    const tutti = await db.diario.orderBy('data').reverse().toArray();
    const u = tutti.find(d => d.peso);
    if(u) {
        document.getElementById('input-peso').value = u.peso;
        document.getElementById('risultato-profilo').innerHTML = `TDEE stimato: ${Math.round(u.tdee)} kcal`;
    }
}

async function resetDatiGiorno(g) {
    const d = ottieniData(g);
    if (confirm("Resettare i dati di questo giorno?")) {
        await db.diario.update(d, { calorieMangiate: 0, proteine: 0, carbo: 0, grassi: 0, calorieBruciate: 0 });
        alert("Dati azzerati.");
        if (document.getElementById("dashboard-box").style.display === "block") disegnaGrafico();
    }
}

// Navigazione
function mostraChat() { document.getElementById("chat-section").style.display = "block"; document.getElementById("dashboard-box").style.display = "none"; }
function mostraDashboard() { document.getElementById("chat-section").style.display = "none"; document.getElementById("dashboard-box").style.display = "block"; caricaProfiloInUI(); disegnaGrafico(); }

// Grafici (Chart.js)
let chartInstance = null;
async function disegnaGrafico() {
    const dati = await db.diario.orderBy('data').toArray();
    const ctx = document.getElementById('graficoCalorie').getContext('2d');
    if(chartInstance) chartInstance.destroy();
    chartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: dati.map(d => d.data),
            datasets: [{ label: 'Calorie', data: dati.map(d => d.calorieMangiate), borderColor: '#28a745' }]
        }
    });
}
