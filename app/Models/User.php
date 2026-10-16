<?php

namespace App\Models;

use Illuminate\Contracts\Auth\MustVerifyEmail;
use Database\Factories\UserFactory;
use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Attributes\Hidden;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Foundation\Auth\User as Authenticatable;
use Illuminate\Notifications\Notifiable;

#[Fillable(['name', 'email', 'password'])]
#[Hidden(['password', 'remember_token'])]
class User extends Authenticatable implements MustVerifyEmail
{
    /** @use HasFactory<UserFactory> */
    use HasFactory, Notifiable;

    /**
     * Get the attributes that should be cast.
     *
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'email_verified_at' => 'datetime',
            'password' => 'hashed',
        ];
    }

    /**
     * Con la verificación de correo apagada (FORMOSA_VERIFICAR_EMAIL=false) todas las cuentas cuentan como verificadas.
     * Así activarla después no obliga a tocar el código: solo se prende la variable.
     */
    public function hasVerifiedEmail(): bool
    {
        return ! config('formosa.auth.verify_email') || $this->email_verified_at !== null;
    }

    public function sendEmailVerificationNotification(): void
    {
        if (config('formosa.auth.verify_email') && ! $this->hasVerifiedEmail()) {
            parent::sendEmailVerificationNotification();
        }
    }

    /** Los moderadores se asignan solo con `php artisan moderador:asignar` (el rol no es asignable en masa). */
    public function isModerator(): bool
    {
        return $this->role === 'moderador';
    }

    /** Participaciones del jugador en partidas (la activa tiene `active_user_id` no nulo). */
    public function matchPlayers(): HasMany
    {
        return $this->hasMany(MatchPlayer::class);
    }
}
