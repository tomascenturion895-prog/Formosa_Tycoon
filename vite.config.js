import { defineConfig } from 'vite';
import laravel from 'laravel-vite-plugin';

export default defineConfig({
    plugins: [
        laravel({
            input: ['resources/css/map.css', 'resources/css/paneles.css', 'resources/css/auth.css', 'resources/css/moderacion.css', 'resources/css/lobby.css', 'resources/js/map/intro.js', 'resources/js/map/main.js', 'resources/js/lobby/main.js'],
            refresh: true,
        }),
    ],
    // El armado de la ciudad 3D corre en un worker de módulo (city-build.worker.js): sale como archivo aparte en /build.
    worker: {
        format: 'es',
    },
    build: {
        // MapLibre (~1 MB) va en un archivo propio: casi nunca cambia, así el navegador lo conserva entre versiones del juego
        // y solo baja de nuevo el código propio (unas decenas de KB).
        rolldownOptions: {
            output: {
                codeSplitting: {
                    groups: [
                        { name: 'maplibre', test: /node_modules[\\/]maplibre-gl/ },
                        // three.js solo lo usa la vista 3D, que se carga al activarla: va aparte para no pesar en la primera carga.
                        { name: 'three', test: /node_modules[\\/]three/ },
                        { name: 'vendor', test: /node_modules[\\/]/ },
                    ],
                },
            },
        },
        chunkSizeWarningLimit: 1200,
    },
    server: {
        watch: {
            ignored: ['**/storage/framework/views/**'],
        },
    },
});
