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
    return recordConTDEE ? recordConTDEE.tdee : 2300;
}

// LOGICA CHAT
async function inviaMessaggio() {
    const inputField = document.getElementById("user-input");
    const testoUtente = inputField.value.trim();
    if (!testoUtente) return;

    const apiKey = ottieniApiKey();
    if (!apiKey) {
        alert("Manca la API Key! Vai nella Dashboard in fondo per configurarla.");
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
        system_instruction: {
            parts: [{ text: systemInstruction }]
        },
        contents: [
            { role: "user", parts: [{ text: testo }] }
        ]
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
    } catch(e) { console.error("Errore parsing JSON", e); }

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

// PROFILO FISICO
function calcolaBMR(peso, altezza, eta, sesso) {
    // Formula Mifflin-St Jeor
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

// DASHBOARD
let chartInstance = null, chartFisicoInstance = null;
let filtroAttuale = 'settimana', metricaAttuale = 'base', metricaFisicaAttuale = 'peso';

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

function cambiaFiltro(n) { filtroAttuale = n; disegnaGrafico(); }
function cambiaMetrica(n) { metricaAttuale = n; disegnaGrafico(); }
function cambiaMetricaFisica(n) { metricaFisicaAttuale = n; disegnaGrafico(); }

async function disegnaGrafico() {
    const oggi = new Date();
    let dataInizio = new Date();
    if (filtroAttuale === 'oggi') dataInizio.setHours(0, 0, 0, 0);
    else if (filtroAttuale === 'settimana') dataInizio.setDate(oggi.getDate() - 7);
    else if (filtroAttuale === 'mese') dataInizio.setMonth(oggi.getMonth() - 1);

    const tuttiIDati = await db.diario.toArray();
    const datiFiltrati = tuttiIDati
        .filter(d => new Date(d.data) >= dataInizio)
        .sort((a, b) => new Date(a.data) - new Date(b.data));

    const labels = datiFiltrati.map(d => d.data);
    const fallbackTDEE = await ottieniTDEEAttuale();

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
