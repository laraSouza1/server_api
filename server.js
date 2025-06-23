const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const mysql = require('mysql2');
const bcrypt = require('bcrypt');
const nodemailer = require('nodemailer');

const server = express();
server.use(cors());
server.use(bodyParser.json());

//conexão com a BD
const db = mysql.createConnection({
    host: "localhost",
    user: "root",
    password: "1234",
    database: "heralert",
});

db.connect(function (error) {
    if (error) {
        console.error("Erro ao conectar a DB:", error);
    } else {
        console.log("Conectado a DB");
    }
});

//esatbelecer porta
server.listen(8085, function check(error) {
    if (error) {
        console.log("Erro", error);
    }
    else {
        console.log("Começou 8085");
    }
});

//const para salvar imagens na bd
const multer = require('multer');
const path = require('path');

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'uploads/'); //tdas as imgs relacionadas a perfil vão para aqui
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + '-' + file.originalname);
    }
});

const upload = multer({ storage: storage });

//---------------TUDO EM RELAÇÃO A USERS---------------//

//view todos users
server.get("/api/users", (req, res) => {
    const search = req.query.search || '';
    const likeSearch = `%${search}%`;
    const currentUserId = parseInt(req.query.currentUserId);
    const limit = parseInt(req.query.limit) || 10;
    const offset = parseInt(req.query.offset) || 0;
    const sortByFollows = req.query.sortByFollows === 'true';

    let selectClause = `SELECT u.id, u.username, u.name, u.email, u.role, u.created_at, COALESCE(r.reports_count, 0) as reports_count`;
    let fromClause = `
    FROM users u
    LEFT JOIN (
      SELECT reported_user_id, COUNT(*) as reports_count
      FROM reports
      GROUP BY reported_user_id
    ) r ON u.id = r.reported_user_id
  `;
    //condição para não mostrar usuários banidos
    let whereClause = ` WHERE u.is_banned = 0 `;

    let queryParams = [];

    //exclui user bloqueadores e bloqueadores se currentID existir
    if (currentUserId) {
        whereClause += `
      AND u.id NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id = ?)
      AND u.id NOT IN (SELECT blocker_id FROM blocks WHERE blocked_id = ?)
    `;
        queryParams.push(currentUserId, currentUserId);
    }

    if (sortByFollows) {
        fromClause += `
      LEFT JOIN follows f ON u.id = f.following_id AND f.follower_id = ?
    `;
        queryParams.push(currentUserId);
    }

    if (search) {
        whereClause += " AND (u.username LIKE ? OR u.name LIKE ?)";
        queryParams.push(likeSearch, likeSearch);
    }

    let orderByClause;
    if (sortByFollows) {
        orderByClause = `
      ORDER BY
      CASE WHEN f.following_id IS NOT NULL THEN 0 ELSE 1 END ASC,
      u.role DESC,
      u.name ASC
    `;
    } else {
        orderByClause = `
      ORDER BY
      u.role DESC,
      CASE
        WHEN u.role = 0 THEN COALESCE(r.reports_count, 0)
        ELSE NULL
      END DESC,
      u.name ASC
    `;
    }

    const countSql = `SELECT COUNT(u.id) as total ${fromClause} ${whereClause}`;
    db.query(countSql, queryParams, (errCount, countResult) => {
        if (errCount) {
            return res.status(500).send({ status: false, message: "Erro ao contar utilizadores." });
        }

        const usersSql = `${selectClause} ${fromClause} ${whereClause} ${orderByClause} LIMIT ? OFFSET ?`;
        let usersParams = [...queryParams, limit, offset];

        db.query(usersSql, usersParams, (errUsers, userResult) => {
            if (errUsers) {
                return res.status(500).send({ status: false, message: "Erro ao buscar utilizadores." });
            }

            res.send({
                status: true,
                data: {
                    users: userResult,
                    total: countResult[0].total
                }
            });
        });
    });
});

//para mudança de role (dar ADM, passar de 0 a 1)
server.put("/api/users/:id/role", (req, res) => {
    const userIdToChange = parseInt(req.params.id);
    const { newRole, currentUserId, currentUserRole } = req.body;

    //validação básica
    if (isNaN(userIdToChange) || !Number.isInteger(newRole) || (newRole !== 0 && newRole !== 1)) {
        return res.status(400).send({ status: false, message: "Dados de alteração de cargo inválidos." });
    }

    //apenar o criador (role 2) consegue dar/remover AMD
    if (currentUserRole !== 2) {
        return res.status(403).send({ status: false, message: "Permissão negada. Apenas a Criadora pode alterar cargos." });
    }

    //previne que o criador mude o prórpio cargo (só é possível pela BD)
    if (userIdToChange === currentUserId) {
        return res.status(403).send({ status: false, message: "Não é possível alterar o cargo da Criadora através desta interface." });
    }

    //previve criadores mudarem cargos de outros criadores se existirem mais de um (ação possível apenas pela BD)
    //obtém o role atual do usuário de destino no banco de dados
    db.query("SELECT role FROM users WHERE id = ?", [userIdToChange], (err, results) => {
        if (err) {
            console.error("Erro ao buscar cargo do usuário alvo:", err);
            return res.status(500).send({ status: false, message: "Erro interno ao verificar cargo." });
        }
        if (results.length === 0) {
            return res.status(404).send({ status: false, message: "Usuário alvo não encontrado." });
        }

        const targetUserCurrentRole = results[0].role;

        if (targetUserCurrentRole === 2) {
            return res.status(403).send({ status: false, message: "Não é possível alterar o cargo de outra Criadora." });
        }

        //certifica de que o novo role seja válido (0 ou 1) e não tente definir a função de Criador (2)
        if (newRole !== 0 && newRole !== 1) {
            return res.status(400).send({ status: false, message: "Novo cargo inválido. Apenas usuária ou administradora são permitidos." });
        }

        //dá update no novo role
        const updateRoleSql = "UPDATE users SET role = ? WHERE id = ?";
        db.query(updateRoleSql, [newRole, userIdToChange], (err, result) => {
            if (err) {
                return res.status(500).send({ status: false, message: "Erro ao atualizar cargo do usuário." });
            }
            if (result.affectedRows === 0) {
                return res.status(404).send({ status: false, message: "Usuário não encontrado ou cargo já é o mesmo." });
            }

            const roleText = newRole === 1 ? "administradora" : "usuária";
            res.send({ status: true, message: `Cargo atualizado para ${roleText} com sucesso.` });
        });
    });
});

global.passwordResetTokens = new Map();

//login
server.post('/api/login', (req, res) => {
    const { usernameOrEmail, password } = req.body;

    const sql = "SELECT * FROM users WHERE email = ? OR username = ?";
    db.query(sql, [usernameOrEmail, usernameOrEmail], (error, result) => {
        if (error) {
            console.error("Erro ao consultar a tabela 'users':", error);
            return res.status(500).send({ status: false, message: "Erro ao acessar a base de dados" });
        }

        if (result.length === 0) {
            console.log("Usuário não encontrado:", usernameOrEmail);
            return res.status(401).send({ status: false, message: "Usuário não encontrado" });
        }

        const user = result[0];

        //verifica se o usuário está banido
        if (user.is_banned === 1) {
            console.log("Usuário banido tentando logar:", user.username);
            return res.status(403).send({ //403 Forbidden para acesso negado
                status: false,
                message: "Você foi banida por receber três ou mais denúncias válidas em seu perfil."
            });
        }

        if (user.password !== password) {
            console.log("Senha incorreta para usuário:", user.username);
            return res.status(401).send({ status: false, message: "Senha incorreta" });
        }

        //se a senha estiver correta e o usuário não estiver banido
        const { password_hash, ...userData } = user;
        res.send({ status: true, data: userData });
    });
});

//envia requisição de link para mudança de palavra-passe caso o user tenha esquecido
server.post('/api/password-reset-request', (req, res) => {
    const { email } = req.body;
    console.log("Requisição de reset de senha para:", email);

    //acha o user por email
    const sql = "SELECT id, username, email FROM users WHERE email = ?";
    db.query(sql, [email], (error, result) => {
        if (error) {
            console.error("Erro ao buscar usuário para reset de senha:", error);
            return res.status(500).send({ status: false, message: "Erro ao acessar a base de dados." });
        }

        if (result.length === 0) {
            return res.status(200).send({ status: true });
        }

        const user = result[0];
        const token = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15); //token aleatório
        const expiresAt = new Date(Date.now() + 60 * 60 * 1000); //token válido por 1 hora

        //armazena o token com ID do usuário e expiração
        if (!global.passwordResetTokens) {
            global.passwordResetTokens = new Map();
        }
        global.passwordResetTokens.set(token, { userId: user.id, expiresAt: expiresAt });

        //constrói o link para att de palavra-passe
        const resetLink = `http://localhost:4200/change-password/${user.id}/${token}`;

        const mailOptions = {
            from: 'heralert.fl@gmail.com',
            to: email,
            subject: 'Redefinição de Palavra-passe Heralert',
            html: `
                <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
                    <h2>Redefinição de Palavra-passe Heralert</h2>
                    <p>Olá ${user.name || user.username},</p>
                    <p>Você solicitou a redefinição da sua palavra-passe. Clique no link abaixo para criar uma nova palavra-passe:</p>
                    <p><a href="${resetLink}" style="background-color: #FF9D9D; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Redefinir Palavra-passe</a></p>
                    <p>Este link é válido por 1 hora.</p>
                    <p>Se você não solicitou esta redefinição, por favor, ignore este e-mail.</p>
                    <p>Atenciosamente,<br/>Equipe Heralert</p>
                </div>
            `
        };

        transporter.sendMail(mailOptions, (mailError, info) => {
            if (mailError) {
                console.error("Erro ao enviar e-mail para redefinir senha:", mailError);
                return res.status(500).send({ status: false });
            }
            console.log('E-mail para redefinir senha enviado:', info.response);
            res.status(200).send({ status: true });
        });
    });
});


//verifica o link de atualização de palavra-passe para ver se ainda é válido
server.get('/api/verify-password-reset-token/:userId/:token', (req, res) => {
    const { userId, token } = req.params;

    if (!global.passwordResetTokens || !global.passwordResetTokens.has(token)) {
        console.log("Token não encontrado (link inválido ou expirado):", token);
        return res.status(400).send({ status: false });
    }

    const tokenData = global.passwordResetTokens.get(token);

    if (tokenData.userId !== parseInt(userId)) { //assegura que o userID é o mesmo
        console.log("UserID no token não corresponde (link inválido):", userId, tokenData.userId);
        return res.status(400).send({ status: false });
    }

    if (new Date() > tokenData.expiresAt) {
        global.passwordResetTokens.delete(token); //remove token expirado
        console.log("Token expirado (link expirado):", token);
        return res.status(400).send({ status: false });
    }

    //token é válido
    res.status(200).send({ status: true, message: "Token válido.", userId: tokenData.userId });
});


//att palavra-passe após reset
server.post('/api/reset-password', (req, res) => {
    const { userId, token, newPassword } = req.body;

    if (!userId || !token || !newPassword) {
        return res.status(400).send({ status: false, message: "Dados incompletos para redefinir a senha." });
    }

    if (!global.passwordResetTokens || !global.passwordResetTokens.has(token)) {
        return res.status(400).send({ status: false, message: "Link inválido ou expirado." });
    }

    const tokenData = global.passwordResetTokens.get(token);

    if (tokenData.userId !== parseInt(userId)) {
        return res.status(400).send({ status: false });
    }

    if (new Date() > tokenData.expiresAt) {
        global.passwordResetTokens.delete(token);
        return res.status(400).send({ status: false });
    }

    const updateSql = "UPDATE users SET password = ? WHERE id = ?";
    db.query(updateSql, [newPassword, userId], (error, result) => {
        if (error) {
            console.error("Erro ao atualizar senha na bd:", error);
            return res.status(500).send({ status: false });
        }

        if (result.affectedRows === 0) {
            return res.status(404).send({ status: false, message: "Usuário não encontrado." });
        }

        global.passwordResetTokens.delete(token); //invalida token após uso
        console.log("Senha do usuário atualizada com sucesso", userId);
        res.status(200).send({ status: true });
    });
});

//cadastro
server.post('/api/register', (req, res) => {
    const { username, name, email, password } = req.body;
    console.log("Tentativa de cadastro com:", { username, name, email });

    const checkUserSql = "SELECT * FROM users WHERE username = ? OR email = ?";
    db.query(checkUserSql, [username, email], (error, result) => {
        if (error) {
            console.error("Erro ao consultar a tabela users:", error);
            return res.status(500).send({ status: false });
        }

        if (result.length > 0) {
            const existingUser = result[0];
            if (existingUser.email === email) {
                return res.status(409).send({ status: false, field: 'email', message: "Email já cadastrado" });
            }
            if (existingUser.username === username) {
                return res.status(409).send({ status: false, field: 'username', message: "Usuário já cadastrado" });
            }
        }

        //coloca user, mas ainda n está verificado
        const insertSql = "INSERT INTO users (username, name, email, password, is_verified) VALUES (?, ?, ?, ?, 0)";
        db.query(insertSql, [username, name, email, password], (error, result) => {
            if (error) {
                console.error("Erro ao inserir usuário:", error);
                return res.status(500).send({ status: false });
            }

            const userId = result.insertId;

            console.log("Usuário pré-cadastrado com sucesso (aguardando verificação):", { id: userId, username, name, email });

            res.send({
                status: true,
                message: "Usuário pré-cadastrado com sucesso. Por favor, verifique seu e-mail.",
                user: { id: userId, email: email }
            });
        });
    });
});

//-------------- sistema de verificação de e-mail -------------------------//

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'heralert.fl@gmail.com',
        pass: 'syuq eqtf rakl rsgg'
    }
});

//inicialização de cadastro
server.post('/api/initiate-registration', (req, res) => {
    const { username, name, email, password } = req.body;

    //verifica se o email já está em uso por um usuário não banido ou se o username já está em uso
    const checkUserSql = "SELECT id, email, username, is_banned FROM users WHERE username = ? OR email = ?";
    db.query(checkUserSql, [username, email], (error, result) => {
        if (error) {
            return res.status(500).send({ status: false, message: "Erro ao acessar a base de dados" });
        }

        if (result.length > 0) {
            const existingUser = result[0];
            if (existingUser.email === email) {
                //se o email existe e o usuário está banido, informa sobre o banimento
                if (existingUser.is_banned === 1) {
                    return res.status(409).send({
                        status: false,
                        field: 'email',
                        message: "A usuária associada a esse e-mail foi banida por receber três ou mais denúncias válidas em seu perfil."
                    });
                }
                //se o email existe e o usuário não está banido, é um email já cadastrado normal
                return res.status(409).send({ status: false, field: 'email', message: "Email já cadastrado" });
            }
            if (existingUser.username === username) {
                if (existingUser.is_banned === 1) {
                    return res.status(409).send({
                        status: false,
                        field: 'username',
                        message: "O nome de usuário associado a esse e-mail foi banido."
                    });
                }
                return res.status(409).send({ status: false, field: 'username', message: "Usuário já cadastrado" });
            }
        }

        //verifica se o email está na tabela banned_users
        const checkBannedEmailSql = "SELECT 1 FROM banned_users WHERE email = ? LIMIT 1";
        db.query(checkBannedEmailSql, [email], (bannedError, bannedResults) => {
            if (bannedError) {
                return res.status(500).send({ status: false, message: "Erro ao acessar a base de dados (banned_users)." });
            }

            if (bannedResults.length > 0) {
                return res.status(409).send({
                    status: false,
                    field: 'email',
                    message: "A usuária associada a esse e-mail foi banida por receber três ou mais denúncias válidas em seu perfil."
                });
            }

            //se passou por todas as verificações, pode iniciar o registro e enviar o e-mail
            const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
            const expiresAt = new Date(Date.now() + 15 * 60 * 1000); //válido por 15 minutos

            //envia email de verificação
            const mailOptions = {
                from: 'heralert.fl@gmail.com',
                to: email,
                subject: 'Código de Verificação Heralert',
                html: `
          <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
            <h2>Verificação de E-mail para Heralert</h2>
            <p>Olá,</p>
            <p>Obrigada por se registrar no Heralert! Para completar o seu cadastro, por favor, utilize o seguinte código de verificação:</p>
            <p style="font-size: 24px; font-weight: bold; color: #FF9D9D; text-align: center; background-color: #f0f0f0; padding: 10px; border-radius: 5px;">${verificationCode}</p>
            <p>Este código é válido por 15 minutos.</p>
            <p>Se você não solicitou este código, por favor, ignore este e-mail.</p>
            <p>Atenciosamente,<br/>Equipe Heralert</p>
          </div>
        `
            };

            transporter.sendMail(mailOptions, (mailError, info) => {
                if (mailError) {
                    console.error("Erro ao enviar e-mail de verificação:", mailError);
                    return res.status(500).send({ status: false, message: "Erro ao enviar e-mail de verificação." });
                }
                console.log('E-mail de verificação enviado:', info.response);

                const pendingRegistrationData = { username, name, email, password, verificationCode, expiresAt };
                if (!global.pendingRegistrations) {
                    global.pendingRegistrations = new Map();
                }
                global.pendingRegistrations.set(email, pendingRegistrationData);

                res.status(200).send({ status: true, message: "Código de verificação enviado com sucesso para o seu e-mail.", email: email });
            });
        });
    });
});

server.post('/api/verify-email-code', (req, res) => {
    const { email, code } = req.body;

    if (!global.pendingRegistrations || !global.pendingRegistrations.has(email)) {
        return res.status(400).send({ status: false, message: "Nenhuma tentativa de registro pendente para este e-mail." });
    }

    const pendingData = global.pendingRegistrations.get(email);

    if (pendingData.verificationCode !== code) {
        return res.status(400).send({ status: false, message: "Código inválido." });
    }

    if (new Date() > pendingData.expiresAt) {
        global.pendingRegistrations.delete(email); //limpa dados expirados
        return res.status(400).send({ status: false, message: "Código expirado." });
    }

    //código valido e n expirado = continua o processo
    const { username, name, password } = pendingData;
    const insertSql = "INSERT INTO users (username, name, email, password, is_verified) VALUES (?, ?, ?, ?, 1)"; //is_verified para 1
    db.query(insertSql, [username, name, email, password], (error, result) => {
        if (error) {
            console.error("Erro ao inserir usuário após verificação:", error);
            if (error.code === 'ER_DUP_ENTRY') {
                return res.status(409).send({ status: false, message: "Usuário ou e-mail já cadastrado (conflito após verificação)." });
            }
            return res.status(500).send({ status: false, message: "Erro ao finalizar cadastro." });
        }

        const userId = result.insertId;
        global.pendingRegistrations.delete(email); //remove de pendendo quando a criação for sucesso

        console.log("Usuário cadastrado e verificado com sucesso:", { id: userId, username, name, email });

        res.status(200).send({
            status: true,
            message: "Usuário cadastrado e verificado com sucesso!",
            user: {
                id: userId,
                username,
                name,
                email,
                profile_pic: null,
                cover_pic: null,
                bio: null,
                created_at: new Date().toISOString(),
                is_verified: true
            }
        });
    });
});

//verifica se já existe certo e-mail no cadastro
server.get('/api/users/check-email', (req, res) => {
    const { email } = req.query;
    const sql = "SELECT 1 FROM users WHERE email = ? LIMIT 1";

    db.query(sql, [email], (err, results) => {
        if (err) {
            console.error("Erro ao verificar email:", err);
            return res.status(500).json({ error: "Erro interno do servidor" });
        }

        res.status(200).json({ exists: results.length > 0 });
    });
});

//verifica se já existe certo username no cadastro
server.get('/api/users/check-username', (req, res) => {
    const { username } = req.query;
    const sql = "SELECT 1 FROM users WHERE username = ? LIMIT 1";

    db.query(sql, [username], (err, results) => {
        if (err) {
            console.error("Erro ao verificar username:", err);
            return res.status(500).json({ error: "Erro interno do servidor" });
        }

        res.status(200).json({ exists: results.length > 0 });
    });
});

//apagar conta
server.delete("/api/users/:id", (req, res) => {
    const userId = parseInt(req.params.id);

    const deletePosts = "DELETE FROM posts WHERE user_id = ?";
    const deleteUser = "DELETE FROM users WHERE id = ?";

    db.query(deletePosts, [userId], (err) => {
        if (err) {
            console.error("Erro ao deletar posts:", err);
            return res.status(500).send({ status: false, message: "Erro ao deletar posts" });
        }

        db.query(deleteUser, [userId], (err) => {
            if (err) {
                console.error("Erro ao deletar usuário:", err);
                return res.status(500).send({ status: false, message: "Erro ao deletar usuário" });
            }

            res.send({ status: true, message: "Usuário e posts deletados com sucesso" });
        });
    });
});

//atualizar perfil
server.put('/api/users/:id', (req, res) => {
    const { id } = req.params;
    //remove o e-mail e a senha do corpo desestruturado para impor fluxos específicos
    const { username, name, bio, profile_pic_url, cover_pic_url } = req.body;

    const sql = `
        UPDATE users
        SET username = ?, name = ?, bio = ?, profile_pic = ?, cover_pic = ?
        WHERE id = ?
    `;

    console.log("SQL (update user profile, excluding email and password):", sql);
    console.log("Valores:", [username, name, bio, profile_pic_url, cover_pic_url, id]);

    db.query(sql, [username, name, bio, profile_pic_url, cover_pic_url, id], (error, result) => {
        if (error) {
            console.error("Erro ao atualizar o perfil (excluindo e-mail e senha):", error);
            return res.status(500).send({ status: false, message: "Erro ao atualizar o perfil" });
        }

        console.log("Resultado da query (update user profile, excluding email and password):", result);
        res.send({ status: true, message: "Perfil atualizado com sucesso!" });
    });
});

//sistema para verificação de email ao atualizar o perfil
global.pendingEmailUpdates = new Map();

server.post('/api/initiate-email-update-verification', (req, res) => {
    const { userId, newEmail } = req.body;

    if (!userId || !newEmail) {
        return res.status(400).send({ status: false, message: "ID do usuário e novo e-mail são obrigatórios." });
    }

    //primeiro verifica se o novo email já está em uso
    const checkEmailSql = "SELECT id FROM users WHERE email = ? AND id != ?";
    db.query(checkEmailSql, [newEmail, userId], (error, result) => {
        if (error) {
            console.error("Erro ao verificar e-mail para atualização:", error);
            return res.status(500).send({ status: false, message: "Erro ao acessar a base de dados." });
        }

        if (result.length > 0) {
            return res.status(409).send({ status: false, message: "Este e-mail já está em uso por outro usuário." });
        }

        const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000); //código válido por 15 minutos

        const mailOptions = {
            from: 'heralert.fl@gmail.com',
            to: newEmail, //manda para o novo email
            subject: 'Código de Verificação para Atualização de E-mail Heralert',
            html: `
            <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
                <h2>Heralert: Verificação de E-mail</h2>
                <p>Olá,</p>
                <p>Você solicitou uma atualização de e-mail para sua conta Heralert. Por favor, utilize o seguinte código de verificação para confirmar o novo e-mail:</p>
                <p style="font-size: 24px; font-weight: bold; color: #FF9D9D; text-align: center; background-color: #f0f0f0; padding: 10px; border-radius: 5px;">${verificationCode}</p>
                <p>Este código é válido por 15 minutos.</p>
                <p>Se você não solicitou esta alteração, por favor, ignore este e-mail.</p>
                <p>Atenciosamente,<br/>Equipe Heralert</p>
            </div>
            `
        };

        transporter.sendMail(mailOptions, (mailError, info) => {
            if (mailError) {
                console.error("Erro ao enviar e-mail de verificação para atualização:", mailError);
                return res.status(500).send({ status: false, message: "Erro ao enviar e-mail de verificação." });
            }
            console.log('E-mail de verificação para atualização enviado:', info.response);

            //armazena dados de atualização pendentes por userId e newEmail para verificação
            if (!global.pendingEmailUpdates) {
                global.pendingEmailUpdates = new Map();
            }

            const key = `${userId}:${newEmail}`;
            global.pendingEmailUpdates.set(key, { userId, newEmail, verificationCode, expiresAt });

            res.status(200).send({ status: true, message: "Código de verificação enviado com sucesso para o novo e-mail." });
        });
    });
});

//para verificar email ao atualizar no perfil
server.post('/api/complete-email-update-verification', (req, res) => {
    const { userId, email, code } = req.body; //o email será o novo email onde será enviado a mensagem

    if (!userId || !email || !code) {
        return res.status(400).send({ status: false, message: "ID do usuário, e-mail e código são obrigatórios." });
    }

    const key = `${userId}:${email}`;
    if (!global.pendingEmailUpdates || !global.pendingEmailUpdates.has(key)) {
        return res.status(400).send({ status: false, message: "Nenhuma tentativa de atualização de e-mail pendente para este usuário e e-mail." });
    }

    const pendingData = global.pendingEmailUpdates.get(key);

    if (pendingData.verificationCode !== code) {
        return res.status(400).send({ status: false, message: "Código inválido." });
    }

    if (new Date() > pendingData.expiresAt) {
        global.pendingEmailUpdates.delete(key);
        return res.status(400).send({ status: false, message: "Código expirado." });
    }

    //att o email na bd
    const updateSql = "UPDATE users SET email = ?, is_verified = 1 WHERE id = ?";
    db.query(updateSql, [email, userId], (error, result) => {
        if (error) {
            console.error("Erro ao atualizar e-mail no banco de dados:", error);
            if (error.code === 'ER_DUP_ENTRY') {
                return res.status(409).send({ status: false, message: "Este e-mail já está em uso." });
            }
            return res.status(500).send({ status: false, message: "Erro ao atualizar e-mail." });
        }

        if (result.affectedRows === 0) {
            return res.status(404).send({ status: false, message: "Usuário não encontrado ou e-mail não foi alterado." });
        }

        global.pendingEmailUpdates.delete(key); //limpa os dados pedentes

        //obtém os dados atualizados do usuário para enviar de volta ao cliente
        const getUserSql = "SELECT id, username, name, email, profile_pic, cover_pic, bio, created_at, is_verified FROM users WHERE id = ?";
        db.query(getUserSql, [userId], (err, userResults) => {
            if (err) {
                console.error("Erro ao buscar usuário após atualização de e-mail:", err);
                return res.status(500).send({ status: false, message: "E-mail atualizado, mas houve um erro ao buscar os dados do usuário." });
            }
            if (userResults.length === 0) {
                return res.status(404).send({ status: false, message: "Usuário não encontrado após atualização de e-mail." });
            }

            console.log("E-mail do usuário atualizado com sucesso:", { userId, newEmail: email });
            res.status(200).send({
                status: true,
                message: "E-mail atualizado com sucesso!",
                user: userResults[0] //Envia de volta o objeto de usuário atualizado completo
            });
        });
    });
});

//ver se já existe usuário com determinado user ao editar perfil
server.get('/api/check-username/:username', (req, res) => {
    const { username } = req.params;
    const userId = req.query.currentUserId;

    let sql = `SELECT COUNT(*) AS count FROM users WHERE username = ?`;
    let params = [username];

    if (userId) {
        sql += ` AND id != ?`;
        params.push(userId);
    }

    db.query(sql, params, (error, result) => {
        if (error) {
            console.error("Erro ao verificar o username:", error);
            return res.status(500).send({ status: false, message: "Erro ao verificar username" });
        }

        const usernameExists = result[0].count > 0;
        res.send({ exists: usernameExists });
    });
});

//upload de imagens (perfil)
server.post('/api/upload', upload.single('image'), (req, res) => {
    if (!req.file) {
        return res.status(400).send({ status: false, message: 'Nenhum arquivo enviado.' });
    }

    const imageUrl = `http://localhost:8085/uploads/${req.file.filename}`;
    res.send({ status: true, url: imageUrl });
});

server.use('/uploads', express.static(path.join(__dirname, 'uploads')));

//SISTEMA DE FOLLOWING E FOLLOWERS

//verificação se segue usuário
server.get("/api/follows/check", (req, res) => {
    const { follower_id, following_id } = req.query;
    const sql = "SELECT * FROM follows WHERE follower_id = ? AND following_id = ?";
    db.query(sql, [follower_id, following_id], (err, results) => {
        if (err) {
            return res.status(500).json({ status: false, message: "Erro no servidor" });
        }
        res.json({ status: true, following: results.length > 0 });
    });
});

//seguir usuário
server.post("/api/follows", (req, res) => {
    const { follower_id, following_id } = req.body;

    const sql = "INSERT IGNORE INTO follows (follower_id, following_id) VALUES (?, ?)";
    db.query(sql, [follower_id, following_id], (err, result) => {
        if (err) {
            return res.status(500).json({ status: false, message: "Erro ao seguir" });
        }

        const wasInserted = result.affectedRows > 0;

        //se foi uma nova inserção (não estava seguindo antes), cria notificação
        if (wasInserted) {
            const notifySql = `
        INSERT INTO notifications (receiver_id, sender_id, type)
        VALUES (?, ?, 'follow')
      `;
            db.query(notifySql, [following_id, follower_id], (notifyErr) => {
                if (notifyErr) {
                    console.error("Erro ao criar notificação de follow:", notifyErr);
                }
            });
        }

        res.json({ status: true, message: wasInserted ? "Seguindo com sucesso" : "Já seguia" });
    });
});

//deixar de seguir usuário
server.delete("/api/follows", (req, res) => {
    const { follower_id, following_id } = req.query;
    const sql = "DELETE FROM follows WHERE follower_id = ? AND following_id = ?";
    db.query(sql, [follower_id, following_id], (err) => {
        if (err) {
            return res.status(500).json({ status: false, message: "Erro ao deixar de seguir" });
        }
        res.json({ status: true, message: "Deixou de seguir com sucesso" });
    });
});

//busca followings para refresh
server.get("/api/follows/following/:userId", (req, res) => {
    const userId = req.params.userId;
    const sql = `
        SELECT f.following_id
        FROM follows f
        JOIN users u ON f.following_id = u.id
        WHERE f.follower_id = ? AND u.is_banned = 0`;
    db.query(sql, [userId], (err, results) => {
        if (err) {
            return res.status(500).json({ status: false, message: "Erro" });
        }
        res.json({ status: true, data: results });
    });
});

//pega todas as pessoas que o user logado segue
server.get("/api/follows/following-users/:userId", (req, res) => {
    const userId = req.params.userId;
    const sql = `
    SELECT u.id, u.username, u.name, u.profile_pic, u.role
    FROM follows f
    JOIN users u ON f.following_id = u.id
    WHERE f.follower_id = ? AND u.is_banned = 0`;
    db.query(sql, [userId], (err, results) => {
        if (err) {
            return res.status(500).json({ status: false, message: "Erro" });
        }
        res.json({ status: true, data: results });
    });
});

//busca todos os seguidores do user logado
server.get("/api/follows/followers-users/:userId", (req, res) => {
    const userId = req.params.userId;
    const sql = `
    SELECT u.id, u.username, u.name, u.profile_pic, u.role
    FROM follows f
    JOIN users u ON f.follower_id = u.id
    WHERE f.following_id = ? AND u.is_banned = 0
    `;
    db.query(sql, [userId], (err, results) => {
        if (err) {
            return res.status(500).json({ status: false, message: "Erro" });
        }
        res.json({ status: true, data: results });
    });
});

//retorna posts dos usuários que o user logado segue
server.get("/api/posts/following/:userId", (req, res) => {
    const userId = parseInt(req.params.userId);
    const search = req.query.search || '';

    const params = [userId];
    let sql = `
      SELECT p.*, u.username, u.name, u.profile_pic, u.role
      FROM posts p
      JOIN users u ON p.user_id = u.id
      WHERE p.user_id IN (
        SELECT following_id FROM follows WHERE follower_id = ?
      )
    `;

    if (search) {
        sql += `
        AND (
          p.title LIKE ? OR
          p.content LIKE ? OR
          u.username LIKE ? OR
          EXISTS (
            SELECT 1 FROM post_tags pt WHERE pt.post_id = p.id AND pt.tag LIKE ?
          )
        )
      `;
        const likeSearch = `%${search}%`;
        params.push(likeSearch, likeSearch, likeSearch, likeSearch);
    }

    sql += ` ORDER BY p.created_at DESC`;

    db.query(sql, params, (err, posts) => {
        if (err) return res.status(500).json({ status: false, message: "Erro ao buscar posts" });

        const postIds = posts.map(post => post.id);

        if (postIds.length === 0) {
            return res.json({ status: true, data: [] });
        }

        const tagSql = `SELECT * FROM post_tags WHERE post_id IN (?)`;
        db.query(tagSql, [postIds], (tagErr, tagsResult) => {
            if (tagErr) return res.status(500).json({ status: false, message: "Erro ao buscar tags" });

            const tagsMap = {};
            tagsResult.forEach(tag => {
                if (!tagsMap[tag.post_id]) tagsMap[tag.post_id] = [];
                tagsMap[tag.post_id].push(tag.tag);
            });

            const fullPosts = posts.map(post => ({
                ...post,
                tags: tagsMap[post.id] || []
            }));

            res.json({ status: true, data: fullPosts });
        });
    });
});

//SISTEMA DE BLOCK E UNBLOCK

//buscar usuário bloqueado por id
server.get("/api/blocks/:userId", (req, res) => {
    const userId = parseInt(req.params.userId);
    const sql = "SELECT blocked_id FROM blocks WHERE blocker_id = ?";
    db.query(sql, [userId], (err, results) => {
        if (err) return res.status(500).send({ status: false, message: "Erro ao buscar bloqueios" });
        res.send({ status: true, data: results });
    });
});

//bloqueia user
server.post("/api/blocks", (req, res) => {
    const { blocker_id, blocked_id } = req.body;

    const insertBlockSql = "INSERT INTO blocks (blocker_id, blocked_id) VALUES (?, ?)";
    db.query(insertBlockSql, [blocker_id, blocked_id], (err) => {
        if (err) return res.status(500).send({ status: false, message: "Erro ao bloquear" });

        //oculta o chat nos dois sentidos
        const insertDeletedChatsSql = `
     INSERT IGNORE INTO deleted_chats (user_id, other_user_id)
     VALUES (?, ?), (?, ?)
   `;
        db.query(insertDeletedChatsSql, [blocker_id, blocked_id, blocked_id, blocker_id], (err2) => {
            if (err2) {
                console.error('Erro ao ocultar chat após bloqueio:', err2);
                return res.status(500).send({ status: false, message: "Erro ao bloquear e ocultar chat" });
            }
            res.send({ status: true, message: "Usuário bloqueado e chat ocultado" });
        });
    });
});

//desbloqueia user
server.delete("/api/blocks", (req, res) => {
    const { blocker_id, blocked_id } = req.query;
    const sql = "DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?";
    db.query(sql, [blocker_id, blocked_id], (err) => {
        if (err) return res.status(500).send({ status: false, message: "Erro ao desbloquear" });
        res.send({ status: true });
    });

    const deleteHiddenSql = `
      DELETE FROM deleted_chats
      WHERE (user_id = ? AND other_user_id = ?)
      OR (user_id = ? AND other_user_id = ?)
    `;
    db.query(deleteHiddenSql, [blocker_id, blocked_id, blocked_id, blocker_id]);
});

//vê quem bloqueou o user
server.get("/api/blocks/blockers/:userId", (req, res) => {
    const userId = parseInt(req.params.userId);
    const sql = "SELECT blocker_id FROM blocks WHERE blocked_id = ?";
    db.query(sql, [userId], (err, results) => {
        if (err) return res.status(500).send({ status: false, message: "Erro ao buscar quem bloqueou" });
        res.send({ status: true, data: results });
    });
});

//detalhes users bloqueados
server.get("/api/users/by-ids", (req, res) => {
    const idsParam = req.query.ids;
    const search = req.query.search || '';

    if (!idsParam) return res.send({ status: true, data: [] });

    const ids = idsParam.split(',').map(id => parseInt(id)).filter(id => !isNaN(id));
    const likeSearch = `%${search}%`;

    let sql = `
      SELECT id, username, name, profile_pic FROM users
      WHERE id IN (?)
    `;
    let params = [ids];

    if (search) {
        sql += " AND (username LIKE ? OR name LIKE ?)";
        params.push(likeSearch, likeSearch);
    }

    db.query(sql, params, (err, result) => {
        if (err) {
            console.error("Erro ao buscar usuários por IDs:", err);
            return res.status(500).send({ status: false, message: "Erro ao buscar usuários" });
        }
        res.send({ status: true, data: result });
    });
});

//------------------------- SISTEMA DE NOTIFICAÇÕES --------------------//

//notificações gerais
server.get('/api/notifications/:userId', (req, res) => {
    const userId = req.params.userId;
    const search = req.query.search || '';

    let sql = `
    SELECT
      n.*,
      u.username,
      u.profile_pic,
      COALESCE(n.post_title, p.title) AS post_title
    FROM notifications n
    LEFT JOIN users u ON n.sender_id = u.id
    LEFT JOIN posts p ON n.post_id = p.id
    WHERE n.receiver_id = ?
  `;

    const params = [userId];

    if (search.trim() !== '') {
        sql += ` AND (
      u.username LIKE ? OR
      COALESCE(n.message, '') LIKE ? OR
      COALESCE(n.post_title, p.title) LIKE ?
    )`;
        const like = `%${search}%`;
        params.push(like, like, like);
    }

    sql += ` ORDER BY n.created_at DESC`;

    db.query(sql, params, (err, results) => {
        if (err) {
            console.error('Erro no banco:', err);
            return res.status(500).send({ status: false, message: 'Erro ao buscar notificações' });
        }
        res.send({ status: true, data: results });
    });
});

//contagem de notificações
server.get("/api/notifications/count/:userId", (req, res) => {
    const userId = req.params.userId;

    const sql = `
    SELECT COUNT(*) AS total
    FROM notifications
    WHERE receiver_id = ?
  `;

    db.query(sql, [userId], (err, result) => {
        if (err) return res.status(500).json({ status: false, message: "Erro ao contar notificações" });
        res.json({ status: true, total: result[0].total });
    });
});

//deletar uma notificação
server.delete("/api/notifications/:id", (req, res) => {
    const id = req.params.id;

    const sql = "DELETE FROM notifications WHERE id = ?";
    db.query(sql, [id], (err, result) => {
        if (err) return res.status(500).json({ status: false, message: "Erro ao deletar notificação." });
        res.json({ status: true, message: "Notificação excluída com sucesso." });
    });
});

//---------------TUDO EM RELAÇÃO A POSTS---------------//

//criar post
server.post('/api/posts', (req, res) => {
    const { user_id, title, content, community, tags, media_url, is_draft } = req.body;

    if (!user_id || !title || !content) {
        return res.status(400).send({ status: false, message: "Campos obrigatórios ausentes" });
    }

    const insertPostSql = `
      INSERT INTO posts (user_id, title, content, community, tags, media_url, is_draft)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `;

    const tagsAsString = tags.join(', ');
    db.query(insertPostSql, [user_id, title, content, community || null, tagsAsString, media_url || null, is_draft || 0], (error, result) => {
        if (error) {
            console.error("Erro ao inserir post:", error);
            return res.status(500).send({ status: false, message: "Erro ao salvar o post" });
        }

        const postId = result.insertId;

        if (tags.length > 0) {
            const tagValues = tags.map(tag => [postId, tag.trim().toLowerCase()]);
            const insertTagsSql = "INSERT INTO post_tags (post_id, tag) VALUES ?";
            db.query(insertTagsSql, [tagValues], (tagErr) => {
                if (tagErr) {
                    console.error("Erro ao inserir tags:", tagErr);
                    return res.status(500).send({ status: false, message: "Erro ao salvar as tags do post" });
                }
                res.send({ status: true, message: "Rascunho salvo com sucesso", postId });
            });
        } else {
            res.send({ status: true, message: "Rascunho salvo com sucesso (sem tags)", postId });
        }
    });
});

//view todos posts
server.get("/api/posts", (req, res) => {
    const userId = parseInt(req.query.userId) || 0;
    const community = req.query.community || null;
    const search = req.query.search || '';
    const tag = req.query.tag || null;

    let sql = `
        SELECT p.*,
            u.username,
            u.role,
            u.name,
            u.profile_pic,
            (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS likes_count,
            (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comments_count,
            (SELECT COUNT(*) FROM likes l WHERE l.user_id = ? AND l.post_id = p.id) > 0 AS user_liked,
            (SELECT COUNT(*) FROM saved_posts s WHERE s.post_id = p.id AND s.user_id = ?) > 0 AS user_saved
        FROM posts p
        JOIN users u ON p.user_id = u.id
    `;

    const params = [userId, userId];
    const whereClauses = [];

    if (community) {
        whereClauses.push(`p.community = ?`);
        params.push(community);
    }

    if (search) {
        whereClauses.push(`
          (p.title LIKE ? OR
            p.content LIKE ? OR
            u.username LIKE ? OR
            p.community LIKE ? OR
            EXISTS (
              SELECT 1 FROM post_tags pt WHERE pt.post_id = p.id AND pt.tag LIKE ?
            ))
        `);
        const likeSearch = `%${search}%`;
        params.push(likeSearch, likeSearch, likeSearch, likeSearch, likeSearch);
    }

    if (tag) {
        whereClauses.push(`EXISTS (
          SELECT 1 FROM post_tags pt
          WHERE pt.post_id = p.id AND pt.tag = ?
        )`);
        params.push(tag);
    }

    if (whereClauses.length > 0) {
        whereClauses.push('p.is_draft = 0');
        sql += ' WHERE ' + whereClauses.join(' AND ');
    } else {
        sql += ' WHERE p.is_draft = 0';
    }

    sql += ` ORDER BY p.created_at DESC`;

    db.query(sql, params, (error, posts) => {
        if (error) {
            console.error("Erro ao buscar posts:", error);
            return res.status(500).send({ status: false, message: "Erro ao buscar posts" });
        }

        const postIds = posts.map(post => post.id);

        if (postIds.length === 0) {
            return res.send({ status: true, data: [] });
        }

        const tagSql = `SELECT * FROM post_tags WHERE post_id IN (?)`;

        db.query(tagSql, [postIds], (tagError, tagsResult) => {
            if (tagError) {
                console.error("Erro ao buscar tags:", tagError);
                return res.status(500).send({ status: false, message: "Erro ao buscar tags" });
            }

            const tagsMap = {};
            tagsResult.forEach(tag => {
                if (!tagsMap[tag.post_id]) tagsMap[tag.post_id] = [];
                tagsMap[tag.post_id].push(tag.tag);
            });

            const fullPosts = posts.map(post => ({
                ...post,
                tags: tagsMap[post.id] || [],
                user_liked: post.user_liked,
                user_saved: post.user_saved
            }));

            res.send({ status: true, data: fullPosts });
        });
    });
});

//pegar um post por id (trás comentários tmb)
server.get("/api/posts/:id", (req, res) => {
    const postId = parseInt(req.params.id);
    const userId = parseInt(req.query.userId) || 0;

    const sql = `
      SELECT p.*,
      u.username,
      u.role,
      u.name,
      u.profile_pic,
      (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS likes_count,
      (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comments_count,
      (SELECT COUNT(*) FROM likes l WHERE l.user_id = ? AND l.post_id = p.id) > 0 AS user_liked,
      (SELECT COUNT(*) FROM saved_posts s WHERE s.post_id = p.id AND s.user_id = ?) > 0 AS user_saved
      FROM posts p
      JOIN users u ON p.user_id = u.id
      WHERE p.id = ?
    `;

    db.query(sql, [userId, userId, postId], (error, results) => {
        if (error || results.length === 0) {
            return res.status(404).send({ status: false, message: "Post não encontrado" });
        }

        const post = results[0];

        const tagSql = `SELECT tag FROM post_tags WHERE post_id = ?`;
        const commentSql = `
            SELECT c.id, c.content, c.created_at, c.user_id, c.parent_id, u.username, u.profile_pic, u.role
            FROM comments c
            JOIN users u ON c.user_id = u.id
            WHERE c.post_id = ?
            ORDER BY c.created_at DESC
        `;

        db.query(tagSql, [postId], (tagErr, tagsResult) => {
            if (tagErr) {
                return res.status(500).send({ status: false, message: "Erro ao buscar tags" });
            }

            const tags = tagsResult.map(t => t.tag);

            db.query(commentSql, [postId], (commentErr, commentsResult) => {
                if (commentErr) {
                    return res.status(500).send({ status: false, message: "Erro ao buscar comentários" });
                }

                res.send({ status: true, data: { ...post, tags, comments: commentsResult } });
            });
        });
    });
});

//adicionar comentário
server.post("/api/comments", (req, res) => {
    const { user_id, post_id, content, parent_id } = req.body;

    const sql = `INSERT INTO comments (user_id, post_id, content, parent_id) VALUES (?, ?, ?, ?)`;
    db.query(sql, [user_id, post_id, content, parent_id || null], (error, result) => {
        if (error) {
            return res.status(500).send({ status: false, message: "Erro ao inserir comentário" });
        }

        const commentId = result.insertId;

        const fetchSql = `
            SELECT c.id, c.content, c.created_at, c.user_id, c.parent_id, u.username, u.profile_pic
            FROM comments c
            JOIN users u ON c.user_id = u.id
            WHERE c.id = ?
        `;
        db.query(fetchSql, [commentId], (fetchError, fetchResult) => {
            if (fetchError) {
                return res.status(500).send({ status: false, message: "Erro ao buscar comentário inserido" });
            }

            //INSERIR NOTIFICAÇÃO
            const notifySql = `
                INSERT INTO notifications (receiver_id, sender_id, type, post_id)
                SELECT p.user_id, ?, 'comment', p.id FROM posts p
                WHERE p.id = ? AND p.user_id != ?
            `;
            db.query(notifySql, [user_id, post_id, user_id], (notifyError) => {
                if (notifyError) {
                    console.error("Erro ao gerar notificação de comentário:", notifyError);
                }

                res.send({ status: true, data: fetchResult[0] });
            });
        });
    });
});

//deletar comentário
server.delete("/api/comments/:id", (req, res) => {
    const commentId = parseInt(req.params.id);

    if (isNaN(commentId)) {
        return res.status(400).send({ status: false, message: "ID do comentário inválido." });
    }

    db.beginTransaction(err => {
        if (err) {
            return res.status(500).send({ status: false, message: "Erro interno ao deletar comentário." });
        }

        const deleteReportsSql = `DELETE FROM reports WHERE target_type = 'comment' AND target_id = ?`;
        db.query(deleteReportsSql, [commentId], (err, reportsResult) => {
            if (err) {
                return db.rollback(() => {
                    console.error("Erro ao deletar denúncias de comentário:", err);
                    res.status(500).send({ status: false, message: "Erro ao deletar denúncias de comentário." });
                });
            }

            const deleteCommentSql = `DELETE FROM comments WHERE id = ?`;
            db.query(deleteCommentSql, [commentId], (err, commentResult) => {
                if (err) {
                    return db.rollback(() => {
                        console.error("Erro ao deletar comentário:", err);
                        res.status(500).send({ status: false, message: "Erro ao deletar comentário." });
                    });
                }

                if (commentResult.affectedRows === 0) {
                    return db.rollback(() => {
                        res.status(404).send({ status: false, message: "Comentário não encontrado." });
                    });
                }

                db.commit(err => {
                    if (err) {
                        return db.rollback(() => {
                            res.status(500).send({ status: false, message: "Erro interno ao deletar comentário." });
                        });
                    }
                    res.status(200).send({ status: true, message: "Comentário e denúncias associadas deletadas com sucesso!" });
                });
            });
        });
    });
});

//atualizar um post
server.put('/api/posts/:id', (req, res) => {
    const postId = req.params.id;
    const { title, content, community, tags, is_draft } = req.body;

    const updateSql = `
        UPDATE posts SET title = ?, content = ?, community = ?, tags = ?, is_draft = ? WHERE id = ?
    `;

    db.query(updateSql, [title, content, community || null, tags.join(', '), is_draft || 0, postId], (err) => {
        if (err) return res.status(500).send({ status: false, message: "Erro ao atualizar o post" });

        const deleteTagsSql = "DELETE FROM post_tags WHERE post_id = ?";
        db.query(deleteTagsSql, [postId], () => {
            if (tags.length > 0) {
                const tagValues = tags.map(tag => [postId, tag.trim().toLowerCase()]);
                const insertTagsSql = "INSERT INTO post_tags (post_id, tag) VALUES ?";
                db.query(insertTagsSql, [tagValues], () => {
                    res.send({ status: true, message: "Post atualizado com sucesso" });
                });
            } else {
                res.send({ status: true, message: "Post atualizado (sem tags)" });
            }
        });
    });
});

//deletar um post
server.delete('/api/posts/:id', (req, res) => {
    const postId = req.params.id;
    let postOwnerId = null;
    let postTitle = null;

    const getPostDetailsSql = "SELECT user_id, title FROM posts WHERE id = ?";
    db.query(getPostDetailsSql, [postId], (err, postResults) => {
        if (err) {
            console.error("Erro ao buscar detalhes do post para notificação:", err);
            return res.status(500).send({ status: false, message: "Erro ao buscar detalhes do post." });
        }
        if (postResults.length === 0) {
            return res.status(404).send({ status: false, message: "Postagem não encontrada." });
        }

        postOwnerId = postResults[0].user_id;
        postTitle = postResults[0].title;

        const deleteTagsSql = "DELETE FROM post_tags WHERE post_id = ?";
        const deleteReportsSql = "DELETE FROM reports WHERE target_type = 'post' AND target_id = ?";
        const deletePostSql = "DELETE FROM posts WHERE id = ?";

        db.query(deleteTagsSql, [postId], (err) => {
            if (err) {
                console.error("Erro ao remover tags do post:", err);
                return res.status(500).send({ status: false, message: "Erro ao remover tags do post" });
            }

            db.query(deleteReportsSql, [postId], (err1) => {
                if (err1) {
                    console.error("Erro ao remover denúncias do post:", err1);
                    return res.status(500).send({ status: false, message: "Erro ao remover denúncias do post" });
                }

                db.query(deletePostSql, [postId], (err2) => {
                    if (err2) {
                        console.error("Erro ao deletar post:", err2);
                        return res.status(500).send({ status: false, message: "Erro ao deletar post" });
                    }

                    const notificationType = 'post_deleted_admin';
                    const notificationMessage = 'Recebemos uma denúncia da sua postagem que se conferiu verdadeira, logo, ela foi excluída.';
                    const insertNotificationSql = `
            INSERT INTO notifications (receiver_id, sender_id, type, post_id, post_title, message)
            VALUES (?, ?, ?, ?, ?, ?)
          `;
                    const adminSenderId = 0;

                    db.query(insertNotificationSql, [postOwnerId, adminSenderId, notificationType, postId, postTitle, notificationMessage], (notifErr) => {
                        if (notifErr) {
                            console.error("Erro ao criar notificação de postagem excluída para o dono:", notifErr);
                        }
                        res.send({ status: true, message: "Postagem e denúncias associadas deletadas com sucesso! Notificação enviada ao usuário." });
                    });
                });
            });
        });
    });
});

//buscars todas as tags
server.get("/api/tags", (req, res) => {
    const search = req.query.search || '';
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 9;
    const offset = (page - 1) * limit;

    const likeSearch = `%${search}%`;

    let baseSql = `
      FROM post_tags pt
      JOIN posts p ON pt.post_id = p.id
      WHERE p.is_draft = 0
    `;
    let countSql = `SELECT COUNT(DISTINCT pt.tag) AS total ${baseSql}`;
    let dataSql = `
      SELECT pt.tag, COUNT(*) AS count
      ${baseSql}
    `;
    let params = [];
    let countParams = [];

    if (search) {
        baseSql += " AND pt.tag LIKE ?";
        dataSql += " AND pt.tag LIKE ?";
        countSql += " AND pt.tag LIKE ?";
        params.push(likeSearch);
        countParams.push(likeSearch);
    }

    dataSql += " GROUP BY pt.tag ORDER BY count DESC";

    dataSql += ` LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    db.query(countSql, countParams, (error, countResult) => {
        if (error) {
            console.error("Erro ao buscar total de tags:", error);
            return res.status(500).send({ status: false, message: "Erro ao buscar total de tags" });
        }

        const totalTags = countResult[0].total;

        db.query(dataSql, params, (error, result) => {
            if (error) {
                console.error("Erro ao buscar tags:", error);
                return res.status(500).send({ status: false, message: "Erro ao buscar tags" });
            }

            res.send({
                status: true,
                data: result,
                total: totalTags
            });
        });
    });
});

//deletar tag
server.delete("/api/tags/:tag", (req, res) => {
    const tagToDelete = req.params.tag;

    const sql = `DELETE FROM post_tags WHERE tag = ?`;

    db.query(sql, [tagToDelete], (error, result) => {
        if (error) {
            console.error("Erro ao deletar tag:", error);
            return res.status(500).send({ status: false, message: "Erro interno do servidor ao deletar tag." });
        }

        if (result.affectedRows === 0) {
            return res.status(404).send({ status: false });
        }

        res.send({ status: true });
    });
});

//adiciona like
server.post("/api/likes", (req, res) => {
    const { user_id, post_id } = req.body;
    const sql = `INSERT INTO likes (user_id, post_id) VALUES (?, ?)`;

    db.query(sql, [user_id, post_id], (error) => {
        if (error) {
            console.error("Erro ao dar like:", error);
            return res.status(500).send({ status: false, message: "Erro ao dar like" });
        }

        //inserir notificação depois que o like for inserido com sucesso
        const notifySql = `
            INSERT INTO notifications (receiver_id, sender_id, type, post_id)
            SELECT p.user_id, ?, 'like', p.id FROM posts p
            WHERE p.id = ? AND p.user_id != ?
        `;
        db.query(notifySql, [user_id, post_id, user_id], (notifyError) => {
            if (notifyError) {
                console.error("Erro ao gerar notificação de like:", notifyError);
            }
            res.send({ status: true });
        });
    });
});

//remove like
server.delete("/api/likes/:userId/:postId", (req, res) => {
    const { userId, postId } = req.params;
    const sql = `DELETE FROM likes WHERE user_id = ? AND post_id = ?`;

    db.query(sql, [userId, postId], (error) => {
        if (error) {
            console.error("Erro ao remover like:", error);
            return res.status(500).send({ status: false, message: "Erro ao remover like" });
        }
        res.send({ status: true });
    });
});

//adiciona postagem salva
server.post("/api/saved_posts", (req, res) => {
    const { user_id, post_id } = req.body;

    console.log("Dados recebidos para salvar:", user_id, post_id);

    if (!user_id || !post_id) {
        return res.status(400).send({ status: false, message: "Dados inválidos." });
    }

    const sql = `INSERT INTO saved_posts (user_id, post_id) VALUES (?, ?)`;
    db.query(sql, [user_id, post_id], (error) => {
        if (error) {
            console.error("Erro ao salvar postagem:", error);
            return res.status(500).send({ status: false, message: "Erro ao salvar postagem" });
        }
        res.send({ status: true });
    });
});

//remove postagem salva
server.delete("/api/saved_posts/:userId/:postId", (req, res) => {

    const { userId, postId } = req.params;
    const sql = `DELETE FROM saved_posts WHERE user_id = ? AND post_id = ?`;

    db.query(sql, [userId, postId], (error) => {
        if (error) {
            console.error("Erro ao remover postagem salva:", error);
            return res.status(500).send({ status: false, message: "Erro ao remover postagem salva" });
        }
        res.send({ status: true });

    });

});

//view posts criados pelo usuário logado/cadastrado
server.get("/api/posts/user/:userId", (req, res) => {
    const userId = parseInt(req.params.userId);
    const search = req.query.search || '';

    let sql = `
      SELECT p.*,
        u.username,
        u.name,
        u.profile_pic,
        u.role,
        (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS likes_count,
        (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comments_count,
        (SELECT COUNT(*) FROM likes l WHERE l.user_id = ? AND l.post_id = p.id) > 0 AS user_liked,
        (SELECT COUNT(*) FROM saved_posts s WHERE s.post_id = p.id AND s.user_id = ?) > 0 AS user_saved
      FROM posts p
      JOIN users u ON p.user_id = u.id
      WHERE p.user_id = ? AND p.is_draft = 0
    `;

    const params = [userId, userId, userId];

    if (search) {
        sql += ` AND (
            p.title LIKE ? OR
            p.content LIKE ? OR
            p.community LIKE ? OR
            EXISTS (
              SELECT 1 FROM post_tags pt WHERE pt.post_id = p.id AND pt.tag LIKE ?
            )
        )`;
        const likeSearch = `%${search}%`;
        params.push(likeSearch, likeSearch, likeSearch, likeSearch);
    }

    sql += ` ORDER BY p.created_at DESC`;

    db.query(sql, params, (error, posts) => {
        if (error) {
            console.error("Erro ao buscar posts do usuário:", error);
            return res.status(500).send({ status: false, message: "Erro ao buscar posts do usuário" });
        }

        const postIds = posts.map(post => post.id);
        if (postIds.length === 0) {
            return res.send({ status: true, data: [] });
        }

        const tagSql = `SELECT * FROM post_tags WHERE post_id IN (?)`;
        db.query(tagSql, [postIds], (tagError, tagsResult) => {
            if (tagError) {
                console.error("Erro ao buscar tags:", tagError);
                return res.status(500).send({ status: false, message: "Erro ao buscar tags" });
            }

            const tagsMap = {};
            tagsResult.forEach(tag => {
                if (!tagsMap[tag.post_id]) tagsMap[tag.post_id] = [];
                tagsMap[tag.post_id].push(tag.tag);
            });

            const fullPosts = posts.map(post => ({
                ...post,
                tags: tagsMap[post.id] || [],
                user_liked: post.user_liked,
                user_saved: post.user_saved
            }));

            res.send({ status: true, data: fullPosts });
        });
    });
});

//buscar posts curtidos por um usuário
server.get("/api/posts/liked/:userId", (req, res) => {
    const userId = parseInt(req.params.userId);
    const search = req.query.search || '';

    let sql = `
      SELECT p.*,
             u.username,
             u.name,
             u.profile_pic,
             u.role,
             (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS likes_count,
             (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comments_count,
             true AS user_liked,
             (SELECT COUNT(*) FROM saved_posts s WHERE s.post_id = p.id AND s.user_id = ?) > 0 AS user_saved
      FROM posts p
      JOIN likes l ON p.id = l.post_id
      JOIN users u ON p.user_id = u.id
      WHERE l.user_id = ?
    `;

    const params = [userId, userId];

    if (search) {
        sql += ` AND (
            p.title LIKE ? OR
            p.content LIKE ? OR
            p.community LIKE ? OR
            u.username LIKE ? OR
            EXISTS (
                SELECT 1 FROM post_tags pt WHERE pt.post_id = p.id AND pt.tag LIKE ?
            )
        )`;
        const likeSearch = `%${search}%`;
        params.push(likeSearch, likeSearch, likeSearch, likeSearch, likeSearch);
    }

    sql += ` ORDER BY p.created_at DESC`;

    db.query(sql, params, (error, posts) => {
        if (error) {
            console.error("Erro ao buscar posts curtidos:", error);
            return res.status(500).send({ status: false, message: "Erro ao buscar posts curtidos" });
        }

        const postIds = posts.map(post => post.id);
        if (postIds.length === 0) return res.send({ status: true, data: [] });

        const tagSql = `SELECT * FROM post_tags WHERE post_id IN (?)`;
        db.query(tagSql, [postIds], (tagError, tagsResult) => {
            if (tagError) {
                console.error("Erro ao buscar tags:", tagError);
                return res.status(500).send({ status: false, message: "Erro ao buscar tags" });
            }

            const tagsMap = {};
            tagsResult.forEach(tag => {
                if (!tagsMap[tag.post_id]) tagsMap[tag.post_id] = [];
                tagsMap[tag.post_id].push(tag.tag);
            });

            const fullPosts = posts.map(post => ({
                ...post,
                tags: tagsMap[post.id] || [],
                user_liked: true,
                user_saved: post.user_saved
            }));

            res.send({ status: true, data: fullPosts });
        });
    });
});

//buscar posts salvos por um usuário
server.get("/api/posts/saved/:userId", (req, res) => {
    const userId = parseInt(req.params.userId);
    const search = req.query.search || '';

    let sql = `
      SELECT p.*,
             u.username,
             u.name,
             u.profile_pic,
             u.role,
             (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS likes_count,
             (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comments_count,
             (SELECT COUNT(*) FROM likes l WHERE l.user_id = ? AND l.post_id = p.id) > 0 AS user_liked,
             true AS user_saved
      FROM posts p
      JOIN saved_posts s ON p.id = s.post_id
      JOIN users u ON p.user_id = u.id
      WHERE s.user_id = ?
    `;

    const params = [userId, userId];

    if (search) {
        sql += ` AND (
            p.title LIKE ? OR
            p.content LIKE ? OR
            p.community LIKE ? OR
            u.username LIKE ? OR
            EXISTS (
                SELECT 1 FROM post_tags pt WHERE pt.post_id = p.id AND pt.tag LIKE ?
            )
        )`;
        const likeSearch = `%${search}%`;
        params.push(likeSearch, likeSearch, likeSearch, likeSearch, likeSearch);
    }

    sql += `ORDER BY created_at DESC`;

    db.query(sql, params, (error, posts) => {
        if (error) {
            console.error("Erro ao buscar posts salvos:", error);
            return res.status(500).send({ status: false, message: "Erro ao buscar posts salvos" });
        }

        const postIds = posts.map(post => post.id);
        if (postIds.length === 0) return res.send({ status: true, data: [] });

        const tagSql = `SELECT * FROM post_tags WHERE post_id IN (?)`;
        db.query(tagSql, [postIds], (tagError, tagsResult) => {
            if (tagError) {
                console.error("Erro ao buscar tags:", tagError);
                return res.status(500).send({ status: false, message: "Erro ao buscar tags" });
            }

            const tagsMap = {};
            tagsResult.forEach(tag => {
                if (!tagsMap[tag.post_id]) tagsMap[tag.post_id] = [];
                tagsMap[tag.post_id].push(tag.tag);
            });

            const fullPosts = posts.map(post => ({
                ...post,
                tags: tagsMap[post.id] || [],
                user_liked: post.user_liked,
                user_saved: true
            }));

            res.send({ status: true, data: fullPosts });
        });
    });
});

//ver rascunhos
server.get("/api/posts/user/:userId/drafts", (req, res) => {
    const userId = parseInt(req.params.userId);
    const search = req.query.search || '';

    let sql = `
      SELECT p.*,
             u.username,
             u.name,
             u.profile_pic,
             u.role
      FROM posts p
      JOIN users u ON p.user_id = u.id
      WHERE p.user_id = ? AND p.is_draft = 1
    `;

    const params = [userId];

    if (search) {
        sql += `
        AND (
          p.title LIKE ? OR
          p.content LIKE ? OR
          p.community LIKE ? OR
          u.username LIKE ? OR
          EXISTS (
            SELECT 1 FROM post_tags pt WHERE pt.post_id = p.id AND pt.tag LIKE ?
          )
        )
      `;
        const likeSearch = `%${search}%`;
        params.push(likeSearch, likeSearch, likeSearch, likeSearch, likeSearch);
    }

    sql += ` ORDER BY p.created_at DESC`;

    db.query(sql, params, (error, posts) => {
        if (error) {
            console.error("Erro ao buscar rascunhos:", error);
            return res.status(500).send({ status: false, message: "Erro ao buscar rascunhos" });
        }

        const postIds = posts.map(post => post.id);
        if (postIds.length === 0) {
            return res.send({ status: true, data: [] });
        }

        const tagSql = `SELECT * FROM post_tags WHERE post_id IN (?)`;
        db.query(tagSql, [postIds], (tagError, tagsResult) => {
            if (tagError) {
                console.error("Erro ao buscar tags:", tagError);
                return res.status(500).send({ status: false, message: "Erro ao buscar tags" });
            }

            const tagsMap = {};
            tagsResult.forEach(tag => {
                if (!tagsMap[tag.post_id]) tagsMap[tag.post_id] = [];
                tagsMap[tag.post_id].push(tag.tag);
            });

            const fullPosts = posts.map(post => ({
                ...post,
                tags: tagsMap[post.id] || []
            }));

            res.send({ status: true, data: fullPosts });
        });
    });
});

//---------------TUDO EM RELAÇÃO A PESQUISA---------------//

//buscar usuário por username
server.get("/api/users/username/:username", (req, res) => {
    const username = req.params.username;
    const sql = `
      SELECT 
        u.*,
        (SELECT COUNT(*) FROM follows WHERE follower_id = u.id) AS followingCount,
        (SELECT COUNT(*) FROM follows WHERE following_id = u.id) AS followersCount
      FROM users u
      WHERE u.username = ?
    `;
    db.query(sql, [username], function (error, result) {
        if (error) {
            console.error("Erro ao buscar usuário:", error);
            res.status(500).send({ status: false, message: "Erro ao acessar a base de dados" });
        } else if (result.length === 0) {
            res.status(404).send({ status: false, message: "Usuário não encontrado" });
        } else {
            res.send({ status: true, data: result[0] });
        }
    });
});

//buscar usuário por id
server.get("/api/users/:id", (req, res) => {
    const userId = req.params.id;
    const sql = "SELECT * FROM users WHERE id = ?";
    db.query(sql, [userId], function (error, result) {
        if (error) {
            console.error("Erro ao buscar usuário:", error);
            res.status(500).send({ status: false, message: "Erro ao acessar a base de dados" });
        } else if (result.length === 0) {
            res.status(404).send({ status: false, message: "Usuário não encontrado" });
        } else {
            res.send({ status: true, data: result[0] });
        }
    });
});

//---------------------------- SISTEMA DE MENSAGENS -----------------------------------------//

//pega os users que o user logado tem chat com
server.get("/api/chats/:userId", (req, res) => {
    const userId = req.params.userId;
    const sql = `
    SELECT
        u.id AS userId,
        u.name AS name,
        u.role AS role,
        u.username AS username,
        u.profile_pic AS profile_pic,
        MAX(m.created_at) AS lastMessageTime,
        (
            SELECT sender_id
            FROM messages
            WHERE ((sender_id = u.id AND receiver_id = ?) OR (sender_id = ? AND receiver_id = u.id))
            ORDER BY created_at DESC
            LIMIT 1
        ) AS lastMessageSenderId,
        (
            SELECT
                CASE
                    WHEN content REGEXP '\\\\.(jpeg|jpg|gif|png|webp)$' THEN '[imagem]'
                    ELSE content
                END
            FROM messages
            WHERE ((sender_id = u.id AND receiver_id = ?) OR (sender_id = ? AND receiver_id = u.id))
            ORDER BY created_at DESC
            LIMIT 1
        ) AS lastMessageContent,
        (
            SELECT COUNT(*)
            FROM messages
            WHERE sender_id = u.id AND receiver_id = ? AND is_read = FALSE
        ) AS unreadCount
    FROM messages m
    JOIN users u
    ON (m.sender_id = u.id AND m.receiver_id = ?)
    OR (m.receiver_id = u.id AND m.sender_id = ?)
    AND NOT EXISTS (
        SELECT 1 FROM deleted_chats dc
        WHERE dc.user_id = ? AND dc.other_user_id = u.id
    )
    AND u.id NOT IN (
        SELECT blocked_id FROM blocks WHERE blocker_id = ?
    )
    AND u.id NOT IN (
        SELECT blocker_id FROM blocks WHERE blocked_id = ?
    )
    GROUP BY u.id, u.name, u.username, u.profile_pic
    ORDER BY lastMessageTime DESC;
    `;

    db.query(sql, [
        userId, userId,
        userId, userId,
        userId,
        userId, userId,
        userId,
        userId,
        userId
    ], function (error, result) {
        if (error) {
            res.status(500).send({ status: false, message: "Erro acessando a BD" });
        } else {
            res.send({ status: true, data: result });
        }
    });
});

//para marcar mensagens como lidas
server.put("/api/messages/read/:senderId/:receiverId", (req, res) => {
    const senderId = req.params.senderId;
    const receiverId = req.params.receiverId;

    const sql = `
    UPDATE messages
    SET is_read = TRUE
    WHERE sender_id = ? AND receiver_id = ? AND is_read = FALSE;
    `;

    db.query(sql, [senderId, receiverId], function (error, result) {
        if (error) {
            res.status(500).send({ status: false, message: "Erro atualizando mensagens" });
        } else {
            res.status(200).send({ status: true, message: "Messages marcadas como lidas com sucesso" });
        }
    });
});

//pega mensagens entre dois users
server.get("/api/messages/:user1Id/:user2Id", (req, res) => {
    const user1Id = req.params.user1Id;
    const user2Id = req.params.user2Id;
    const sql = `
        SELECT *
        FROM messages
        WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)
        ORDER BY created_at ASC;
    `;
    db.query(sql, [user1Id, user2Id, user2Id, user1Id], function (error, result) {
        if (error) {
            res.status(500).send({ status: false, message: "Erro acessando a BD" });
        } else {
            res.send({ status: true, data: result });
        }
    });
});

//nova mensagem
server.post("/api/messages", (req, res) => {
    const { sender_id, receiver_id, content } = req.body;
    const sql = "INSERT INTO messages (sender_id, receiver_id, content) VALUES (?, ?, ?)";
    db.query(sql, [sender_id, receiver_id, content], function (error, result) {
        if (error) {
            res.status(500).send({ status: false, message: "Erro enviando mensagem" });
        } else {
            //retorna o ID da nova mensagem inserida
            res.status(201).send({ status: true, message: "Mensagem enviada com sucesso", data: { id: result.insertId } });
        }
    });
});

//deleta mensagem
server.delete("/api/messages/:id", (req, res) => {
    const messageId = req.params.id;
    const sql = "DELETE FROM messages WHERE id = ?";
    db.query(sql, [messageId], function (error, result) {
        if (error) {
            res.status(500).send({ status: false, message: "Erro deletando mensagem" });
        } else {
            res.status(200).send({ status: true, message: "Mensagem deletada com sucesso" });
        }
    });
});

//marcar o chat como deletado para o user atual
server.post("/api/deleted-chats", (req, res) => {
    const { user_id, other_user_id } = req.body;

    //verifica se o chat já foi marcado como deletado
    const checkSql = "SELECT * FROM deleted_chats WHERE user_id = ? AND other_user_id = ?";
    db.query(checkSql, [user_id, other_user_id], (err, result) => {
        if (err) {
            return res.status(500).send({ status: false, message: "Erro ao verificar chat oculto" });
        }

        //se já existe um registro, o chat já está "excluido"
        if (result.length > 0) {
            return res.send({ status: true, message: "Chat já está oculto para este usuário." });
        } else {
            //insere o registro para marcar o chat como deletado
            const insertSql = "INSERT INTO deleted_chats (user_id, other_user_id) VALUES (?, ?)";
            db.query(insertSql, [user_id, other_user_id], (err) => {
                if (err) {
                    return res.status(500).send({ status: false, message: "Erro ao ocultar chat" });
                }
                res.send({ status: true, message: "Chat ocultado com sucesso." });
            });
        }
    });
});

//apagar mensagens apenas para o usuário logado em um chat específico
server.post("/api/delete-messages-only", (req, res) => {
    const { user_id, other_user_id } = req.body;
    const sql = `
        DELETE FROM messages
        WHERE (sender_id = ? AND receiver_id = ?)
           OR (sender_id = ? AND receiver_id = ?)
    `;
    db.query(sql, [user_id, other_user_id, other_user_id, user_id], (err) => {
        if (err) {
            return res.status(500).send({ status: false, message: "Erro ao apagar mensagens" });
        }
        res.send({ status: true, message: "Mensagens apagadas com sucesso." });
    });
});

//para reexibir um chat que foi marcado como deletado
server.post("/api/unhide-chat", (req, res) => {
    const { user_id, other_user_id } = req.body;

    //remove o registro de chat deletado
    const deleteSql = "DELETE FROM deleted_chats WHERE user_id = ? AND other_user_id = ?";
    db.query(deleteSql, [user_id, other_user_id], (err, result) => {
        if (err) {
            console.error(err);
            return res.status(500).send({ status: false, message: "Erro ao restaurar chat" });
        }
        res.send({ status: true, message: "Chat restaurado com sucesso" });
    });
});

//------------------------------- SISTEMA DE DENÚNCIAS -----------------------------------------------

//para fazer uma denùncia
server.post("/api/reports", (req, res) => {
    const { reporter_id, reported_user_id, target_type, target_id, reason } = req.body;

    if (!reporter_id || !reported_user_id || !target_type || !target_id || !reason) {
        return res.status(400).send({ status: false, message: "Dados da denúncia incompletos." });
    }

    const allowedTargetTypes = ['user', 'post', 'comment'];
    if (!allowedTargetTypes.includes(target_type)) {
        return res.status(400).send({ status: false, message: "Tipo de alvo de denúncia inválido." });
    }

    const sql = `
        INSERT INTO reports (reporter_id, reported_user_id, target_type, target_id, reason)
        VALUES (?, ?, ?, ?, ?)
    `;

    console.log("Recebido:", { reporter_id, reported_user_id, target_type, target_id, reason });

    db.query(sql, [reporter_id, reported_user_id, target_type, target_id, reason], (error, results) => {
        if (error) {
            console.error("Erro ao registrar denúncia:", error);
            return res.status(500).send({ status: false, message: "Erro interno ao registrar denúncia." });
        }
        res.status(201).send({ status: true, message: "Denúncia registrada com sucesso!", reportId: results.insertId });
    });
});

//para deletar uma denúncia
server.delete("/api/reports/:id", (req, res) => {
    const reportId = req.params.id;

    if (!reportId) {
        return res.status(400).send({ status: false, message: "ID da denúncia não fornecido." });
    }

    const sql = `DELETE FROM reports WHERE id = ?`;

    db.query(sql, [reportId], (error, results) => {
        if (error) {
            console.error("Erro ao deletar denúncia:", error);
            return res.status(500).send({ status: false, message: "Erro interno ao deletar denúncia." });
        }

        if (results.affectedRows === 0) {
            return res.status(404).send({ status: false, message: "Denúncia não encontrada." });
        }

        res.status(200).send({ status: true, message: "Denúncia deletada com sucesso!" });
    });
});

//para buscar reports de posts e comentários
server.get("/api/reports", (req, res) => {
    const { search, status, limit, offset, targetType } = req.query;

    let baseSql = `
        SELECT
            r.id AS report_id,
            r.target_id AS target_id,
            r.created_at AS report_created_at,
            r.reason AS report_reason,
            r.status AS report_status,
            r.status_reason_text AS status_reason_text,
            rep_u.username AS reporter_username,
            rep_u.name AS reporter_name,
            reported_u.username AS reported_username,
            reported_u.name AS reported_name,
            COALESCE(p_post.title, p_comment.title) AS post_title,
            COALESCE(p_post.community, p_comment.community) AS post_community,
            COALESCE(p_post.id, p_comment.id) AS post_id,
            c.content AS comment_text,
            c.post_id AS comment_post_id
        FROM heralert.reports r
        JOIN users rep_u ON r.reporter_id = rep_u.id
        JOIN users reported_u ON r.reported_user_id = reported_u.id
        LEFT JOIN comments c ON r.target_type = 'comment' AND r.target_id = c.id
        LEFT JOIN posts p_post ON r.target_type = 'post' AND r.target_id = p_post.id
        LEFT JOIN posts p_comment ON r.target_type = 'comment' AND c.post_id = p_comment.id
    `;

    const conditions = [];
    const params = [];

    if (targetType) {
        conditions.push("r.target_type = ?");
        params.push(targetType);
    } else {
        conditions.push("r.target_type = 'post'");
    }

    if (status) {
        conditions.push("r.status = ?");
        params.push(status);
    }

    if (search) {
        if (targetType === 'post') {
            conditions.push("(p.title LIKE ? OR rep_u.username LIKE ? OR reported_u.username LIKE ?)");
            params.push(`%${search}%`, `%${search}%`, `%${search}%`);
        } else if (targetType === 'comment') {
            conditions.push("(c.content LIKE ? OR rep_u.username LIKE ? OR reported_u.username LIKE ?)");
            params.push(`%${search}%`, `%${search}%`, `%${search}%`);
        } else {
            conditions.push("(p.title LIKE ? OR c.content LIKE ? OR rep_u.username LIKE ? OR reported_u.username LIKE ?)");
            params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
        }
    }

    if (conditions.length > 0) {
        baseSql += " WHERE " + conditions.join(" AND ");
    }

    const countSql = `SELECT COUNT(*) AS total FROM (${baseSql}) AS subquery`;

    const paginatedSql = `${baseSql} ORDER BY r.created_at DESC LIMIT ? OFFSET ?`;
    const paginatedParams = [...params, parseInt(limit), parseInt(offset)];

    db.query(countSql, params, (countError, countResults) => {
        if (countError) {
            console.error("Erro interno ao buscar denúncias (contagem):", countError);
            return res.status(500).send({ status: false, message: "Erro interno ao buscar denúncias." });
        }
        const totalReports = countResults[0].total;

        db.query(paginatedSql, paginatedParams, (error, results) => {
            if (error) {
                console.error("Erro interno ao buscar denúncias:", error);
                return res.status(500).send({ status: false, message: "Erro interno ao buscar denúncias." });
            }
            res.send({ status: true, data: { reports: results, total: totalReports } });
        });
    });
});

//para atualizar estado da denuncia de post/comentário
server.put("/api/reports/:id/status", (req, res) => {
    const reportId = req.params.id;
    const { status, reason } = req.body;

    if (!status) {
        return res.status(400).send({ status: false, message: "Status é obrigatório." });
    }

    if ((status === 'nao_justificado' || status === 'justificado') && !reason) {
        return res.status(400).send({ status: false, message: "O motivo do estado é obrigatório para este status." });
    }

    const getReportDetailsSql = `
        SELECT
            r.reporter_id,
            r.reported_user_id,
            r.target_type,
            r.target_id,
            p.title AS post_title,
            c.content AS comment_text,
            c.post_id AS comment_post_id
        FROM heralert.reports r
        JOIN users rep_u ON r.reporter_id = rep_u.id
        LEFT JOIN comments c ON r.target_type = 'comment' AND r.target_id = c.id
        LEFT JOIN posts p ON
            (r.target_type = 'post' AND r.target_id = p.id) OR
            (r.target_type = 'comment' AND c.post_id = p.id)
        WHERE r.id = ?
    `;

    db.query(getReportDetailsSql, [reportId], (err, reportDetails) => {
        if (err) {
            console.error("Erro ao buscar detalhes da denúncia:", err);
            return res.status(500).send({ status: false, message: "Erro interno ao buscar detalhes da denúncia." });
        }
        if (reportDetails.length === 0) {
            return res.status(404).send({ status: false, message: "Denúncia não encontrada." });
        }

        const reporterId = reportDetails[0].reporter_id;
        const reportedUserId = reportDetails[0].reported_user_id;
        const targetType = reportDetails[0].target_type;
        const targetId = reportDetails[0].target_id;
        const postTitle = reportDetails[0].post_title;
        const commentText = reportDetails[0].comment_text;
        const commentPostId = reportDetails[0].comment_post_id;

        const sql = `
            UPDATE heralert.reports
            SET status = ?, status_reason_text = ?
            WHERE id = ?
        `;

        db.query(sql, [status, reason, reportId], (error, results) => {
            if (error) {
                console.error("Erro ao atualizar status da denúncia:", error);
                return res.status(500).send({ status: false, message: "Erro interno ao atualizar status da denúncia." });
            }
            if (results.affectedRows === 0) {
                return res.status(404).send({ status: false, message: "Denúncia não encontrada." });
            }

            res.status(200).send({ status: true, message: "Status da denúncia atualizado com sucesso." });

            if (status === 'justificado' || status === 'nao_justificado') {
                let notificationMessageToReporter = '';
                let relevantPostIdForReporter = null;
                let relevantPostTitleForReporter = null; //título do post para a notificação do denunciante

                if (targetType === 'post') {
                    if (status === 'justificado') {
                        notificationMessageToReporter = 'Recebemos sua denúncia e, após uma avaliação, ela se conferiu válida. Logo, a postagem foi excluída.';
                    } else { //nao_justificado
                        notificationMessageToReporter = 'Recebemos sua denúncia e, após uma avaliação, ela não se conferiu válida. Logo, a postagem não foi excluída.';
                    }
                    relevantPostIdForReporter = targetId;
                    relevantPostTitleForReporter = postTitle; //usa o título do post diretamente
                } else if (targetType === 'comment') {
                    if (status === 'justificado') {
                        notificationMessageToReporter = 'Recebemos sua denúncia e, após uma avaliação, ela se conferiu válida. Logo, o comentário foi excluído.';
                    } else { //nao_justificado
                        notificationMessageToReporter = 'Recebemos sua denúncia e, após uma avaliação, ela não se conferiu válida. Logo, o comentário não foi excluído.';
                    }
                    relevantPostIdForReporter = commentPostId; //ID do post pai do comentário
                    relevantPostTitleForReporter = `Comentário em: "${postTitle || 'Postagem sem título'}"`; //título do post pai
                }

                const adminSenderId = 0;

                const insertNotificationSql = `
          INSERT INTO notifications (receiver_id, sender_id, type, post_id, post_title, message)
          VALUES (?, ?, ?, ?, ?, ?)
        `;

                //notificar o denunciante (reporterId)
                db.query(insertNotificationSql, [reporterId, adminSenderId, 'report_outcome_admin', relevantPostIdForReporter, relevantPostTitleForReporter, notificationMessageToReporter], (notifErr) => {
                    if (notifErr) {
                        console.error("Erro (fire-and-forget) ao criar notificação de resultado da denúncia para o denunciante:", notifErr);
                    }
                });

                //lógica de notificação para o Usuário Reportado (se o conteúdo foi excluído)
                if (status === 'justificado') {
                    let notificationMessageToReportedUser = '';
                    let relevantPostIdForReported = null;
                    let relevantPostTitleForReported = null; //título do post para a notificação do usuário reportado

                    if (targetType === 'post') {
                        notificationMessageToReportedUser = 'Recebemos uma denúncia de uma postagem sua que se conferiu verdadeira, logo, ela foi excluída.';
                        relevantPostIdForReported = targetId;
                        relevantPostTitleForReported = postTitle; //usa o título do post
                    } else if (targetType === 'comment') {
                        notificationMessageToReportedUser = 'Recebemos uma denúncia de um comentário seu que se conferiu verdadeira, logo, ele foi excluído.';
                        relevantPostIdForReported = commentPostId; //ID do post pai do comentário
                        relevantPostTitleForReported = `Comentário em: "${postTitle || 'Postagem sem título'}"`; //título do post pai
                    }

                    if (reportedUserId && reportedUserId !== reporterId) {
                        db.query(insertNotificationSql, [reportedUserId, adminSenderId, 'content_deleted_by_report', relevantPostIdForReported, relevantPostTitleForReported, notificationMessageToReportedUser], (notifErr) => {
                            if (notifErr) {
                                console.error("Erro (fire-and-forget) ao criar notificação para o usuário reportado sobre exclusão de conteúdo:", notifErr);
                            }
                        });
                    }
                }
            }
        });
    });
});

//busca denúncias de usuários
server.get("/api/user-reports", (req, res) => {
    const { search, status, limit, offset } = req.query;

    let baseSql = `
    SELECT
      r.id AS report_id,
      r.created_at AS report_created_at,
      r.reason AS report_reason,
      r.status AS report_status,
      r.status_reason_text AS status_reason_text,
      rep_u.username AS reporter_username,
      rep_u.name AS reporter_name,
      reported_u.id AS reported_user_id,
      reported_u.username AS reported_username,
      reported_u.name AS reported_name,
      reported_u.role AS reported_user_role,
      (SELECT COUNT(*) FROM reports WHERE reported_user_id = reported_u.id AND target_type = 'user') AS total_user_reports_count
    FROM heralert.reports r
    JOIN users rep_u ON r.reporter_id = rep_u.id
    JOIN users reported_u ON r.reported_user_id = reported_u.id
    WHERE r.target_type = 'user'
  `;

    const conditions = [];
    const params = [];

    if (status) {
        conditions.push("r.status = ?");
        params.push(status);
    }

    if (search) {
        conditions.push("(rep_u.username LIKE ? OR reported_u.username LIKE ? OR reported_u.name LIKE ?)");
        params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    if (conditions.length > 0) {
        baseSql += " AND " + conditions.join(" AND ");
    }

    const countSql = `SELECT COUNT(*) AS total FROM (${baseSql}) AS subquery`;

    const paginatedSql = `${baseSql} ORDER BY r.created_at DESC LIMIT ? OFFSET ?`;
    const paginatedParams = [...params, parseInt(limit), parseInt(offset)];

    db.query(countSql, params, (countError, countResults) => {
        if (countError) {
            console.error("Erro interno ao buscar denúncias de usuários (contagem):", countError);
            return res.status(500).send({ status: false, message: "Erro interno ao buscar denúncias de usuários." });
        }
        const totalReports = countResults[0].total;

        db.query(paginatedSql, paginatedParams, (error, results) => {
            if (error) {
                console.error("Erro interno ao buscar denúncias de usuários:", error);
                return res.status(500).send({ status: false, message: "Erro interno ao buscar denúncias de usuários." });
            }
            res.send({ status: true, data: { reports: results, total: totalReports } });
        });
    });
});

//para att o estado da denúncia de usuário
server.put("/api/user-reports/:id/status", (req, res) => {
    const reportId = req.params.id;
    const { status, reason } = req.body;

    if (!status) {
        return res.status(400).send({ status: false, message: "Status é obrigatório." });
    }

    if ((status === 'nao_justificado' || status === 'justificado') && !reason) {
        return res.status(400).send({ status: false, message: "O motivo do estado é obrigatório para este status." });
    }

    //obtem os detalhes da denúncia e a contagem atual de denúncias válidas
    const getReportDetailsSql = `
    SELECT
      r.reporter_id,
      r.reported_user_id,
      r.status AS current_report_status,
      reported_u.username AS reported_username,
      (SELECT COUNT(*) FROM reports WHERE reported_user_id = r.reported_user_id AND target_type = 'user' AND status = 'justificado') AS current_total_valid_user_reports_count
    FROM heralert.reports r
    JOIN users reported_u ON r.reported_user_id = reported_u.id
    WHERE r.id = ? AND r.target_type = 'user'
  `;

    db.query(getReportDetailsSql, [reportId], (err, reportDetails) => {
        if (err) {
            console.error("Erro ao buscar detalhes da denúncia de usuário:", err);
            return res.status(500).send({ status: false, message: "Erro interno ao buscar detalhes da denúncia de usuário." });
        }
        if (reportDetails.length === 0) {
            return res.status(404).send({ status: false, message: "Denúncia de usuário não encontrada ou não é do tipo 'user'." });
        }

        const reporterId = reportDetails[0].reporter_id;
        const reportedUserId = reportDetails[0].reported_user_id;
        const reportedUsername = reportDetails[0].reported_username;
        const currentReportStatus = reportDetails[0].current_report_status; //status atual da denúncia
        let totalValidUserReportsCount = reportDetails[0].current_total_valid_user_reports_count;

        //ajuste a contagem de denúncias válidas com base na mudança de status
        if (status === 'justificado' && currentReportStatus !== 'justificado') {
            //se o novo status é 'justificado' e o anterior não era 'justificado', incrementa
            totalValidUserReportsCount++;
        } else if (status === 'nao_justificado' && currentReportStatus === 'justificado') {
            //se o novo status é 'nao_justificado' e o anterior era 'justificado', decrementa
            totalValidUserReportsCount--;
        }
        //se o status não mudou ou mudou para 'em_avaliacao', a contagem permanece a mesma para a lógica de banimento.

        const sql = `
      UPDATE heralert.reports
      SET status = ?, status_reason_text = ?
      WHERE id = ? AND target_type = 'user'
    `;

        db.query(sql, [status, reason, reportId], (error, results) => {
            if (error) {
                console.error("Erro ao atualizar status da denúncia de usuário:", error);
                return res.status(500).send({ status: false, message: "Erro interno ao atualizar status da denúncia de usuário." });
            }
            if (results.affectedRows === 0) {
                return res.status(404).send({ status: false, message: "Denúncia de usuário não encontrada ou não é do tipo 'user'." });
            }

            res.status(200).send({ status: true, message: "Status da denúncia de usuário atualizado com sucesso." });

            const adminSenderId = 0; //ID para o "sistema" ou "administrador"
            const insertNotificationSql = `
        INSERT INTO notifications (receiver_id, sender_id, type, message)
        VALUES (?, ?, ?, ?)
      `;

            //notificação para o DENUNCIANTE
            let notificationMessageToReporter = '';
            if (status === 'justificado') {
                if (totalValidUserReportsCount >= 3) { //se o banimento ocorrer
                    notificationMessageToReporter = `Recebemos sua denúncia contra o usuário ${reportedUsername} e, após uma avaliação, ela se conferiu válida. Logo, a usuária foi banida.`;
                } else {
                    notificationMessageToReporter = `Recebemos sua denúncia contra o usuário ${reportedUsername} e, após uma avaliação, ela se conferiu válida. A usuária foi notificada sobre isso.`;
                }
            } else { //status === 'nao_justificado'
                notificationMessageToReporter = `Recebemos sua denúncia contra o usuário ${reportedUsername} e, após uma avaliação, ela não se conferiu válida.`;
            }

            db.query(insertNotificationSql, [reporterId, adminSenderId, 'report_outcome_user_admin', notificationMessageToReporter], (notifErr) => {
                if (notifErr) {
                    console.error("Erro (fire-and-forget) ao criar notificação de resultado da denúncia de usuário para o denunciante:", notifErr);
                }
            });

            //notificação para o USUÁRIO DENUNCIADO (apenas se a denujncia for válida)
            if (status === 'justificado' && reportedUserId !== reporterId) {
                let notificationMessageToReportedUser = '';
                if (totalValidUserReportsCount >= 3) {
                    notificationMessageToReportedUser = `Recebemos uma denúncia contra você que se conferiu verdadeira. Ao atingir 3 ou mais denúncias válidas, você foi banida.`;

                } else {
                    notificationMessageToReportedUser = `Recebemos uma denúncia contra você e, após uma avaliação, ela se conferiu válida. Atualmente você tem ${totalValidUserReportsCount} denúncia(s) válida(s) associada(s) à sua conta. Ao atingir 3 ou mais denúncias válidas, você será banida.`;
                }

                db.query(insertNotificationSql, [reportedUserId, adminSenderId, 'report_outcome_user_admin', notificationMessageToReportedUser], (notifErr) => {
                    if (notifErr) {
                        console.error("Erro (fire-and-forget) ao criar notificação de resultado da denúncia de usuário para o denunciado:", notifErr);
                    }
                });
            }
        });
    });
});

//busca usuários a banir (que têm 3 ou mais denúncias válidas)
server.get("/api/users-to-ban", (req, res) => {
    const { limit, offset, search } = req.query;

    let searchCondition = "";
    let searchParams = [];

    if (search && search.trim() !== "") {
        searchCondition = " AND (u.username LIKE ? OR u.name LIKE ? OR u.email LIKE ?)";
        const searchTermLike = `%${search.trim()}%`;
        searchParams = [searchTermLike, searchTermLike, searchTermLike];
    }

    const baseSql = `
    SELECT
      u.id AS user_id,
      u.username,
      u.name,
      u.email,
      u.role,
      COUNT(r.id) AS total_valid_reports,
      (SELECT COUNT(*) FROM reports WHERE reported_user_id = u.id AND target_type = 'user') AS total_user_reports_count
    FROM users u
    JOIN reports r ON u.id = r.reported_user_id
    WHERE r.target_type = 'user' AND r.status = 'justificado'
    ${searchCondition}
    GROUP BY u.id, u.username, u.name, u.email, u.role
    HAVING COUNT(r.id) >= 3
  `;

    const countSql = `SELECT COUNT(*) AS total FROM (${baseSql}) AS subquery`;
    const paginatedSql = `${baseSql} ORDER BY total_valid_reports DESC, u.username ASC LIMIT ? OFFSET ?`;

    db.query(countSql, searchParams, (countError, countResults) => {
        if (countError) {
            console.error("Erro ao contar usuários a serem banidos:", countError);
            return res.status(500).send({ status: false, message: "Erro ao buscar usuários para banir." });
        }
        const totalUsers = countResults[0].total;

        db.query(paginatedSql, [...searchParams, parseInt(limit), parseInt(offset)], (error, results) => {
            if (error) {
                console.error("Erro ao buscar usuários a serem banidos:", error);
                return res.status(500).send({ status: false, message: "Erro ao buscar usuários para banir." });
            }
            res.send({ status: true, data: { users: results, total: totalUsers } }); //retorna 'users' e 'total'
        });
    });
});

//buscar detalhes das denúncias válidas de um usuário específico
server.get("/api/users/:userId/valid-reports-details", (req, res) => {
    const userId = parseInt(req.params.userId);

    if (isNaN(userId)) {
        return res.status(400).send({ status: false, message: "ID do usuário inválido." });
    }

    const sql = `
    SELECT
      r.id AS report_id,
      r.created_at AS report_created_at,
      r.reason AS report_reason,
      r.status AS report_status,
      r.status_reason_text AS status_reason_text,
      rep_u.username AS reporter_username
    FROM reports r
    JOIN users rep_u ON r.reporter_id = rep_u.id
    WHERE r.reported_user_id = ? AND r.target_type = 'user' AND r.status = 'justificado'
    ORDER BY r.created_at DESC;
  `;

    db.query(sql, [userId], (error, results) => {
        if (error) {
            console.error("Erro ao buscar detalhes de denúncias válidas do usuário:", error);
            return res.status(500).send({ status: false, message: "Erro interno ao buscar detalhes de denúncias." });
        }
        res.send({ status: true, data: { validReports: results } });
    });
});

//para banir um usuário
server.put("/api/users/:id/ban", (req, res) => {
    const userIdToBan = parseInt(req.params.id);
    const currentUserRole = req.body.currentUserRole;
    const currentUserId = req.body.currentUserId; //receber o user ID atual do cliente

    if (isNaN(userIdToBan)) {
        return res.status(400).send({ status: false, message: "ID de usuário inválido." });
    }

    //previne auto-banimento server-side
    if (currentUserId && userIdToBan === currentUserId) {
        return res.status(403).send({ status: false, message: "Você não pode banir sua própria conta." });
    }

    //pega o role do user que está sendo banido da BD
    const getUserRolesSql = "SELECT role FROM users WHERE id = ?";
    db.query(getUserRolesSql, [userIdToBan], (err, targetUserResults) => {
        if (err) {
            return res.status(500).send({ status: false, message: "Erro interno ao banir usuário." });
        }
        if (targetUserResults.length === 0) {
            return res.status(404).send({ status: false, message: "Usuário não encontrado." });
        }

        const targetUserRole = targetUserResults[0].role;

        //check de autorização por níveis 
        if (currentUserRole < targetUserRole || (currentUserRole === targetUserRole && currentUserRole !== 2)) {
            let errorMessage = "Você não tem permissão para banir esta usuária.";
            if (currentUserRole === 1 && targetUserRole === 1) {
                errorMessage = "Como administradora, você não pode banir outras administradoras.";
            } else if (currentUserRole === 1 && targetUserRole === 2) {
                errorMessage = "Como administradora, você não pode banir a criadora.";
            } else if (currentUserRole === 0) {
                errorMessage = "Como usuária, você não tem permissão para realizar banimentos.";
            }
            return res.status(403).send({ status: false, message: errorMessage });
        }

        //se passa da autorização chechk, segue o processo de banimento
        const getUserEmailSql = "SELECT email, username FROM users WHERE id = ?";
        db.query(getUserEmailSql, [userIdToBan], (err, userResults) => {
            if (err) {
                console.error("Erro ao buscar e-mail do usuário para banir:", err);
                return res.status(500).send({ status: false, message: "Erro interno ao banir usuário." });
            }
            if (userResults.length === 0) {
                return res.status(404).send({ status: false, message: "Usuário não encontrado." });
            }

            const userEmail = userResults[0].email;
            const username = userResults[0].username;

            db.beginTransaction(err => {
                if (err) {
                    console.error("Erro ao iniciar transação para banimento:", err);
                    return res.status(500).send({ status: false, message: "Erro interno ao banir usuário." });
                }

                const banUserSql = `
          UPDATE users
          SET username = CONCAT('banned_', id),
          email = CONCAT('banned_', id, '@banned.com'),
          name = '[Usuário Banido]',
          bio = NULL,
          profile_pic = NULL,
          cover_pic = NULL,
          password = '',
          is_banned = 1
          WHERE id = ?;
        `;

                db.query(banUserSql, [userIdToBan], (err) => {
                    if (err) {
                        return db.rollback(() => {
                            res.status(500).send({ status: false, message: "Erro ao banir usuário (marcação)." });
                        });
                    }

                    const insertBannedEmailSql = "INSERT INTO banned_users (user_id, email) VALUES (?, ?) ON DUPLICATE KEY UPDATE banned_at = CURRENT_TIMESTAMP";
                    db.query(insertBannedEmailSql, [userIdToBan, userEmail], (err) => {
                        if (err) {
                            return db.rollback(() => {
                                console.error("Erro ao inserir e-mail em banned_users:", err);
                                res.status(500).send({ status: false, message: "Erro ao banir usuário (registro de e-mail)." });
                            });
                        }

                        const deletePostsSql = "DELETE FROM posts WHERE user_id = ?";
                        db.query(deletePostsSql, [userIdToBan], (err) => {
                            if (err) {
                                return db.rollback(() => {
                                    console.error("Erro ao deletar posts do usuário banido:", err);
                                    res.status(500).send({ status: false, message: "Erro ao banir usuário (posts)." });
                                });
                            }

                            const deleteCommentsSql = "DELETE FROM comments WHERE user_id = ?";
                            db.query(deleteCommentsSql, [userIdToBan], (err) => {
                                if (err) {
                                    return db.rollback(() => {
                                        console.error("Erro ao deletar comentários do usuário banido:", err);
                                        res.status(500).send({ status: false, message: "Erro ao banir usuário (comentários)." });
                                    });
                                }

                                const deleteReportsSql = "DELETE FROM reports WHERE reporter_id = ? OR reported_user_id = ?";
                                db.query(deleteReportsSql, [userIdToBan, userIdToBan], (err) => {
                                    if (err) {
                                        return db.rollback(() => {
                                            console.error("Erro ao deletar denúncias relacionadas ao usuário banido:", err);
                                            res.status(500).send({ status: false, message: "Erro ao banir usuário (denúncias)." });
                                        });
                                    }

                                    const deleteChatMessagesSql = "DELETE FROM messages WHERE sender_id = ? OR receiver_id = ?";
                                    db.query(deleteChatMessagesSql, [userIdToBan, userIdToBan], (err) => {
                                        if (err) {
                                            return db.rollback(() => {
                                                console.error("Erro ao deletar mensagens de chat do usuário banido:", err);
                                                res.status(500).send({ status: false, message: "Erro ao banir usuário (chat)." });
                                            });
                                        }

                                        db.commit(err => {
                                            if (err) {
                                                return db.rollback(() => {
                                                    console.error("Erro ao commitar transação de banimento:", err);
                                                    res.status(500).send({ status: false, message: "Erro interno ao banir usuário." });
                                                });
                                            }
                                            res.status(200).send({ status: true, message: `Usuária ${username} banida com sucesso!` });
                                        });
                                    });
                                });
                            });
                        });
                    });
                });
            });
        });
    });
});