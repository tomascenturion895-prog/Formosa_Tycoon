<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\RateLimiter;
use Tests\TestCase;

class AuthTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->withoutVite();
        config(['formosa.economy.start_money' => 30000]);
    }

    private function valid(array $over = []): array
    {
        return $over + ['name' => 'Lucía_91', 'email' => 'Lucia@Example.com', 'password' => 'clave1234', 'password_confirmation' => 'clave1234'];
    }

    public function test_las_pantallas_de_cuenta_cargan(): void
    {
        $this->get('/registro')->assertOk()->assertSee('Crear cuenta');
        $this->get('/ingresar')->assertOk()->assertSee('Ingresar');
    }

    public function test_registrarse_crea_la_cuenta_sin_dinero_y_abre_sesion(): void
    {
        $this->post('/registro', $this->valid())->assertRedirect('/mapa');

        $user = User::where('name', 'Lucía_91')->firstOrFail();
        $this->assertAuthenticatedAs($user);
        $this->assertSame('lucia@example.com', $user->email, 'el correo se guarda en minúsculas');
        $this->assertNotSame('clave1234', $user->password);
        $this->assertSame([0, 0, 0], [$user->rank_points, $user->matches_played, $user->matches_won], 'el dinero se recibe al empezar cada partida, no al registrarse');
        $this->assertSame(0, \DB::table('match_players')->count());
    }

    #[\PHPUnit\Framework\Attributes\DataProvider('invalidos')]
    public function test_datos_invalidos_se_rechazan(array $over, string $campo): void
    {
        $this->from('/registro')->post('/registro', $this->valid($over))->assertRedirect('/registro')->assertSessionHasErrors($campo);

        $this->assertSame(0, User::count());
        $this->assertGuest();
    }

    public static function invalidos(): array
    {
        return [
            'apodo muy corto' => [['name' => 'ab'], 'name'],
            'apodo con html' => [['name' => '<script>x</script>'], 'name'],
            'apodo largo' => [['name' => str_repeat('a', 25)], 'name'],
            'apodo con letras cirilicas parecidas' => [['name' => "\u{0410}dmin"], 'name'], // "А" cirílica: se parece a la A latina
            'apodo en griego' => [['name' => "\u{0391}\u{0392}\u{0393}"], 'name'],
            'correo malo' => [['email' => 'no-es-un-correo'], 'email'],
            'clave corta' => [['password' => 'a1', 'password_confirmation' => 'a1'], 'password'],
            'clave sin numeros' => [['password' => 'sololetrasss', 'password_confirmation' => 'sololetrasss'], 'password'],
            'confirmacion distinta' => [['password_confirmation' => 'otra12345'], 'password'],
        ];
    }

    public function test_el_apodo_y_el_correo_no_se_pueden_repetir(): void
    {
        User::factory()->create(['name' => 'Lucía_91', 'email' => 'otro@example.com']);

        $this->post('/registro', $this->valid())->assertSessionHasErrors('name');

        User::factory()->create(['email' => 'lucia@example.com']);
        $this->post('/registro', $this->valid(['name' => 'Otra Persona']))->assertSessionHasErrors('email');
    }

    public function test_el_apodo_no_distingue_mayusculas_ni_espacios_repetidos(): void
    {
        User::factory()->create(['name' => 'Juan Pérez', 'email' => 'jp@example.com']);

        $this->post('/registro', $this->valid(['name' => 'juan   pérez']))->assertSessionHasErrors('name');
        $this->post('/registro', $this->valid(['name' => 'JUAN PÉREZ']))->assertSessionHasErrors('name');
        $this->assertSame(1, User::count());
    }

    public function test_no_se_puede_imitar_un_apodo_con_letras_de_ancho_completo_o_numerales(): void
    {
        User::factory()->create(['name' => 'Admin', 'email' => 'admin@example.com']);

        $this->post('/registro', $this->valid(['name' => "\u{FF21}\u{FF44}\u{FF4D}\u{FF49}\u{FF4E}"]))->assertSessionHasErrors('name'); // Ａｄｍｉｎ
        $this->assertSame(1, User::count());

        // Un numeral romano (Ⅰ) no pasa por dígito: se normaliza a la letra común, así que se guarda "JugadorI" y no un nombre "parecido".
        $this->post('/registro', $this->valid(['name' => "Jugador\u{2160}", 'email' => 'otro@example.com']))->assertRedirect('/mapa');
        $this->assertSame('JugadorI', User::where('email', 'otro@example.com')->value('name'));
    }

    public function test_acentos_y_enie_se_aceptan(): void
    {
        $this->post('/registro', $this->valid(['name' => 'Ñandú José']))->assertRedirect('/mapa');
    }

    public function test_el_registro_tiene_limite_por_minuto_y_por_ip(): void
    {
        RateLimiter::clear('registro');
        for ($i = 0; $i < 6; $i++) {
            $this->post('/registro', ['name' => 'x']); // inválido a propósito: igual cuenta como intento
        }

        $this->post('/registro', $this->valid())->assertStatus(429);
        $this->assertSame(0, User::count());
    }

    public function test_los_espacios_repetidos_del_apodo_se_normalizan(): void
    {
        $this->post('/registro', $this->valid(['name' => 'Juan   Pérez']));

        $this->assertSame('Juan Pérez', User::firstOrFail()->name);
    }

    public function test_ingresar_con_datos_correctos(): void
    {
        $user = User::factory()->create(['email' => 'a@example.com', 'password' => 'clave1234']);

        $this->post('/ingresar', ['email' => 'A@example.com', 'password' => 'clave1234'])->assertRedirect('/mapa');

        $this->assertAuthenticatedAs($user);
    }

    public function test_ingresar_con_datos_malos_da_el_mismo_mensaje_exista_o_no_el_correo(): void
    {
        User::factory()->create(['email' => 'a@example.com', 'password' => 'clave1234']);

        $a = $this->post('/ingresar', ['email' => 'a@example.com', 'password' => 'mala']);
        $b = $this->post('/ingresar', ['email' => 'nadie@example.com', 'password' => 'mala']);

        $a->assertSessionHasErrors('email');
        $this->assertSame(session()->get('errors')->first('email'), trans('auth.failed'));
        $b->assertSessionHasErrors('email');
        $this->assertGuest();
    }

    public function test_tras_cinco_intentos_fallidos_se_bloquea_incluso_con_la_clave_correcta(): void
    {
        RateLimiter::clear('a@example.com|127.0.0.1');
        User::factory()->create(['email' => 'a@example.com', 'password' => 'clave1234']);

        for ($i = 0; $i < 5; $i++) {
            $this->post('/ingresar', ['email' => 'a@example.com', 'password' => 'mala']);
        }
        $this->post('/ingresar', ['email' => 'a@example.com', 'password' => 'clave1234'])->assertSessionHasErrors('email');

        $this->assertGuest();
    }

    public function test_salir_cierra_la_sesion(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user)->post('/salir')->assertRedirect('/mapa');

        $this->assertGuest();
    }

    public function test_quien_ya_ingreso_no_ve_las_pantallas_de_cuenta(): void
    {
        $this->actingAs(User::factory()->create())->get('/ingresar')->assertRedirect('/mapa');
    }

    public function test_los_formularios_traen_token_csrf(): void
    {
        $this->get('/registro')->assertSee('name="_token"', false);
        $this->get('/ingresar')->assertSee('name="_token"', false);
    }
}
