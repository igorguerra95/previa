import React from 'react';

export default function App() {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col items-center justify-center p-6 selection:bg-blue-600 selection:text-white">
      <main className="text-center max-w-lg space-y-4">
        <div className="w-12 h-12 rounded-xl bg-blue-600/20 border border-blue-500/30 flex items-center justify-center mx-auto text-blue-400">
          <div className="w-4 h-4 rounded-full bg-blue-500 animate-pulse" />
        </div>
        <h1 className="text-2xl font-bold tracking-tight text-white">
          Base Pronta
        </h1>
        <p className="text-sm text-slate-400 leading-relaxed">
          Ambiente limpo e configurado com React, Vite e Tailwind CSS, pronto para receber o novo projeto.
        </p>
      </main>
    </div>
  );
}
