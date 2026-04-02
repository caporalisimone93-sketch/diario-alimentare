// REGISTRAZIONE SERVICE WORKER (PWA)
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js')
      .then(() => console.log("Service Worker Registrato"))
      .catch(err => console.log("Errore SW:", err));
}

// CONFIGURAZIONE API (BYOK)
const API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent";

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
    diario: 'data, calorieMangiate, proteine, carbo, grassi, calorieBurned'
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

// FUNZIONE RESET
async function resetDatiGiorno(giorniIndietro) {
    const dataTarget = ottieniData(giorniIndietro);
    const confermi = confirm(`Vuoi davvero azzerare i pasti e lo sport di ${giorniIndietro === 0 ? 'OGGI' : 'IERI'}?`);
    if (confermi) {
        const record = await db.diario.get(dataTarget);
        if (record) {
            await db.diario.update(dataTarget, {
                calorieMangiate: 0, proteine: 0, carbo: 0, grassi: 0, calorieBruciate: 0
            });
            alert("Resettato!");
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
    return recordConTDEE ? recordConTDEE.tdee : 2300; 
}

// LOGICA CHAT
async function inviaMessaggio() {
    const inputField = document.getElementById("user-input");
    const testoUtente = inputField.value.trim();
    if (!testoUtente) return; 

    const apiKey = ottieniApiKey();
    if (!apiKey) {
        alert("Inserisci la API Key nel campo sotto la chat!");
        return;
    }

    aggiungiMessaggio("Tu", testoUtente);
    inputField.value = ""; 
    aggiungiMessaggio("Dietologo", "...");

    try {
        const risposta = await faiDomandaAGemini(testoUtente, apiKey);
        const chatBox = document.getElementById("chat-box");
        chatBox.lastElementChild.innerHTML = `<strong>Dietologo:</strong> ${escapeHTML(risposta)}`;
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
    let memoriaPasti = "Pasti tipici: " + pastiSalvati.map(p => `"${p.nome}" (${p.calorie}kcal)`).join(", ");
    const tdeeAttuale = await ottieniTDEEAttuale();

    const systemInstruction = `Sei un dietologo sintetico. Analizza l'input dell'utente.
REGOLE RIGIDE:
1. Capisci se l'utente parla di OGGI (${dataOggi}) o di IERI (${dataIeri}).
2. Rispondi SOLO con l'analisi del nuovo pasto/allenamento e un commento tecnico brevissimo.
3. Dati già salvati: OGGI = ${recordOggi.calorieMangiate} kcal, IERI = ${recordIeri.calorieMangiate} kcal.
4. ${memoriaPasti}
Fabbisogno Base: ${Math.round(tdeeAttuale)} kcal.

Formato JSON obbligatorio alla fine:
\`\`\`json
{"data_riferimento": "${dataOggi}", "calorie_mangiate": 0, "proteine": 0, "carboidrati": 0, "grassi": 0, "calorie_bruciate": 0}
\`\`\``;

    const requestBody = {
        contents: [{ parts: [{ text: `SYSTEM: ${systemInstruction}\nUSER: ${testo}` }] }]
    };

    const response = await fetch(`${API_URL}?key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody)
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Errore API');
    
    const testoRisposta = data.candidates[0].content.parts[0].text;
    try {
        const parti = testoRisposta.split("```json");
        if (parti.length > 1) {
            const datiNuovi = JSON.parse(parti[1].split("```")[0].trim());
            await aggiornaDiario(datiNuovi);
        }
    } catch(e) { console.error("JSON Error", e); }

    return testoRisposta.split("```json")[0].trim();
}

async function aggiornaDiario(datiNuovi) {
    const dataTarget = datiNuovi.data_riferimento || ottieniData(0); 
    const recordTarget = await db.diario.get(dataTarget) || { calorieMangiate: 0, proteine: 0, carbo: 0, grassi: 0, calorieBruciate: 0 };
    await db.diario.put({
        ...recordTarget,
        data: dataTarget,
        calorieMangiate: (recordTarget.calorieMangiate || 0) + (datiNuovi.calorie_mangiate || 0),
        proteine: (recordTarget.proteine || 0) + (datiNuovi.proteine || 0),
        carbo: (recordTarget.carbo || 0) + (datiNuovi.carboidrati || 0),
        grassi: (recordTarget.grassi || 0) + (datiNuovi.grassi || 0),
        calorieBruciate: (recordTarget.calorieBruciate || 0) + (datiNuovi.calorie_bruciate || 0)
    });
}

function aggiungiMessaggio(m, t) {
    const c = document.getElementById("chat-box");
    const p = document.createElement("p");
    p.innerHTML = `<strong>${m}:</strong> ${escapeHTML(t).replace(/\n/g, "<br>")}`;
    c.appendChild(p);
    c.scrollTop = c.scrollHeight;
}

document.getElementById("user-input").addEventListener("keypress", (e) => { if (e.key === "Enter") inviaMessaggio(); });

// PROFILO FISICO E GRAFICI
function calcolaBMR(peso, altezza, eta, sesso) {
    return sesso === 'M' ? (10 * peso) + (6.25 * altezza) - (5 * eta) + 5 : (10 * peso) + (6.25 * altezza) - (5 * eta) - 161;
}

async function salvaProfilo() {
    const peso = parseFloat(document.getElementById('input-peso').value);
    const altezza = parseFloat(document.getElementById('input-altezza').value);
    const eta = parseInt(document.getElementById('input-eta').value);
    const sesso = document.getElementById('input-sesso').value;
    if(!peso || !altezza || !eta) return alert("Compila i campi!");

    const bmr = calcolaBMR(peso, altezza, eta, sesso);
    const tdee = bmr * 1.2; 
    const bmi = peso / ((altezza/100) * (altezza/100));

    localStorage.setItem('profilo_altezza', altezza);
    localStorage.setItem('profilo_eta', eta);
    localStorage.setItem('profilo_sesso', sesso);

    const oggi = ottieniData(0);
    const recordOggi = await db.diario.get(oggi) || { calorieMangiate: 0, proteine: 0, carbo: 0, grassi: 0, calorieBruciate: 0 };
    await db.diario.put({ ...recordOggi, data: oggi, peso, bmi, bmr, tdee });
    alert("Profilo Salvato!");
}

async function caricaProfiloInUI() {
    document.getElementById('input-altezza').value = localStorage.getItem('profilo_altezza') || '';
    document.getElementById('input-eta').value = localStorage.getItem('profilo_eta') || '';
    document.getElementById('input-sesso').value = localStorage.getItem('profilo_sesso') || 'M';
    const tutti = await db.diario.orderBy('data').reverse().toArray();
    const u = tutti.find(d => d.peso);
    if(u) {
        document.getElementById('input-peso').value = u.peso;
        document.getElementById('risultato-profilo').innerHTML = `BMR: ${Math.round(u.bmr)} | TDEE: ${Math.round(u.tdee)} | BMI: ${u.bmi.toFixed(1)}`;
    }
}

// CAMBIO PAGINA
function mostraChat() {
    document.getElementById("chat-section").style.display = "block";
    document.getElementById("dashboard-box").style.display = "none";
}

function mostraDashboard() {
    document.getElementById("chat-section").style.display = "none";
    document.getElementById("dashboard-box").style.display = "block";
    caricaProfiloInUI();
    disegnaGrafico();
}

let chartInstance = null, chartFisicoInstance = null; 
let filtroAttuale = 'settimana', metricaAttuale = 'base', metricaFisicaAttuale = 'peso';

function cambiaFiltro(n) { filtroAttuale = n; disegnaGrafico(); }
function cambiaMetrica(n) { metricaAttuale = n; disegnaGrafico(); }
function cambiaMetricaFisica(n) { metricaFisicaAttuale = n; disegnaGrafico(); }

async function disegnaGrafico() {
    const oggi = new Date();
    let dataInizio = new Date();
    if (filtroAttuale === 'oggi') dataInizio.setHours(0,0,0,0);
    else if (filtroAttuale === 'settimana') dataInizio.setDate(oggi.getDate() - 7);
    else if (filtroAttuale === 'mese') dataInizio.setMonth(oggi.getMonth() - 1);

    const tuttiIDati = await db.diario.toArray();
    const datiFiltrati = tuttiIDati.filter(d => new Date(d.data) >= dataInizio).sort((a,b) => new Date(a.data) - new Date(b.data));
    const labels = datiFiltrati.map(d => d.data);
    const fallbackTDEE = await ottieniTDEEAttuale();

    let ds1 = [];
    if (metricaAttuale === 'base') {
        ds1 = [
            { label: 'Mangiate', data: datiFiltrati.map(d => d.calorieMangiate || 0), borderColor: '#28a745', tension: 0.3 },
            { label: 'Target', data: datiFiltrati.map(d => (d.tdee || fallbackTDEE) + (d.calorieBruciate || 0)), borderColor: '#007bff', borderDash: [5, 5], tension: 0.3 }
        ];
    } else if (metricaAttuale === 'deficit') {
        ds1 = [{ label: 'Bilancio', data: datiFiltrati.map(d => (d.calorieMangiate || 0) - ((d.tdee || fallbackTDEE) + (d.calorieBruciate || 0))), borderColor: '#dc3545', tension: 0.3 }];
    } else {
        const m = metricaAttuale === 'carboidrati' ? 'carbo' : metricaAttuale;
        ds1 = [{ label: metricaAttuale, data: datiFiltrati.map(d => d[m] || 0), borderColor: '#6f42c1', tension: 0.3 }];
    }

    const ctx1 = document.getElementById('graficoCalorie').getContext('2d');
    if(chartInstance) chartInstance.destroy(); 
    chartInstance = new Chart(ctx1, { type: 'line', data: { labels, datasets: ds1 } });

    let datiFisici = datiFiltrati.filter(d => d[metricaFisicaAttuale] !== undefined);
    const ctx2 = document.getElementById('graficoFisico').getContext('2d');
    if(chartFisicoInstance) chartFisicoInstance.destroy(); 
    chartFisicoInstance = new Chart(ctx2, { 
        type: 'line', 
        data: { 
            labels: datiFisici.map(d => d.data), 
            datasets: [{ label: metricaFisicaAttuale.toUpperCase(), data: datiFisici.map(d => d[metricaFisicaAttuale]), borderColor: '#e83e8c', fill: false }] 
        } 
    });
}
