const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const mysql = require('mysql2');
const bcrypt = require('bcrypt');

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

    let sql = `
        SELECT * FROM users 
        WHERE id != ?
          AND id NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id = ?)
          AND id NOT IN (SELECT blocker_id FROM blocks WHERE blocked_id = ?)
    `;
    let params = [currentUserId, currentUserId, currentUserId];

    if (search) {
        sql += " AND (username LIKE ? OR name LIKE ?)";
        params.push(likeSearch, likeSearch);
    }

    db.query(sql, params, (error, result) => {
        if (error) {
            console.error("Erro ao consultar a tabela 'users':", error);
            res.status(500).send({ status: false, message: "Erro ao acessar a base de dados" });
        } else {
            res.send({ status: true, data: result });
        }
    });
});

//login
server.post('/api/login', (req, res) => {
    const { usernameOrEmail, password } = req.body;
    console.log("Tentativa de login com:", { usernameOrEmail, password });

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

        if (user.password !== password) {
            console.log("Senha incorreta para usuário:", user.username);
            return res.status(401).send({ status: false, message: "Senha incorreta" });
        }

        const { password_hash, ...userData } = user;
        res.send({ status: true, data: userData });
    });
});

//cadastro
server.post('/api/register', (req, res) => {
    const { username, name, email, password } = req.body;
    console.log("Tentativa de cadastro com:", { username, name, email });

    const checkUserSql = "SELECT * FROM users WHERE username = ? OR email = ?";
    db.query(checkUserSql, [username, email], (error, result) => {
        if (error) {
            console.error("Erro ao consultar a tabela 'users':", error);
            return res.status(500).send({ status: false, message: "Erro ao acessar a base de dados" });
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

        const insertSql = "INSERT INTO users (username, name, email, password) VALUES (?, ?, ?, ?)";
        db.query(insertSql, [username, name, email, password], (error, result) => {
            if (error) {
                console.error("Erro ao inserir usuário:", error);
                return res.status(500).send({ status: false, message: "Erro ao cadastrar usuário" });
            }

            const userId = result.insertId;

            console.log("Usuário cadastrado com sucesso:", { id: userId, username, name, email });

            res.send({
                status: true,
                message: "Usuário cadastrado com sucesso",
                user: {
                    id: userId,
                    username,
                    name,
                    email,
                    profile_pic: null,
                    cover_pic: null,
                    bio: null,
                    created_at: new Date().toISOString()
                }
            });
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
    const { username, name, email, bio, profile_pic_url, cover_pic_url } = req.body;

    const sql = `
        UPDATE users
        SET username = ?, name = ?, email = ?, bio = ?, profile_pic = ?, cover_pic = ?
        WHERE id = ?
    `;

    console.log("SQL:", sql);
    console.log("Valores:", [username, name, email, bio, profile_pic_url, cover_pic_url, id]);

    db.query(sql, [username, name, email, bio, profile_pic_url, cover_pic_url, id], (error, result) => {
        if (error) {
            console.error("Erro ao atualizar o perfil:", error);
            return res.status(500).send({ status: false, message: "Erro ao atualizar o perfil" });
        }

        console.log("Resultado da query:", result);
        res.send({ status: true, message: "Perfil atualizado com sucesso!" });
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
    const sql = "SELECT following_id FROM follows WHERE follower_id = ?";
    db.query(sql, [userId], (err, results) => {
        if (err) return res.status(500).json({ status: false, message: "Erro" });
        res.json({ status: true, data: results });
    });
});

//pega todas as pessoas que o user logado segue
server.get("/api/follows/following-users/:userId", (req, res) => {
    const userId = req.params.userId;
    const sql = `
      SELECT u.id, u.username, u.name, u.profile_pic
      FROM follows f
      JOIN users u ON f.following_id = u.id
      WHERE f.follower_id = ?`;
    db.query(sql, [userId], (err, results) => {
        if (err) return res.status(500).json({ status: false, message: "Erro" });
        res.json({ status: true, data: results });
    });
});

//busca todos os seguidores do user logado
server.get("/api/follows/followers-users/:userId", (req, res) => {
    const userId = req.params.userId;
    const sql = `
      SELECT u.id, u.username, u.name, u.profile_pic
      FROM follows f
      JOIN users u ON f.follower_id = u.id
      WHERE f.following_id = ?
    `;
    db.query(sql, [userId], (err, results) => {
        if (err) return res.status(500).json({ status: false, message: "Erro" });
        res.json({ status: true, data: results });
    });
});

//retorna posts dos usuários que o user logado segue
server.get("/api/posts/following/:userId", (req, res) => {
    const userId = parseInt(req.params.userId);
    const search = req.query.search || '';

    const params = [userId];
    let sql = `
      SELECT p.*, u.username, u.name, u.profile_pic
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
    const sql = "INSERT INTO blocks (blocker_id, blocked_id) VALUES (?, ?)";
    db.query(sql, [blocker_id, blocked_id], (err) => {
        if (err) return res.status(500).send({ status: false, message: "Erro ao bloquear" });
        res.send({ status: true });
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
            SELECT c.id, c.content, c.created_at, c.user_id, c.parent_id, u.username, u.profile_pic
            FROM comments c
            JOIN users u ON c.user_id = u.id
            WHERE c.post_id = ?
            ORDER BY c.created_at ASC
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

            res.send({ status: true, data: fetchResult[0] });
        });
    });
});

//deletar comentário
server.delete("/api/comments/:id", (req, res) => {
    const commentId = parseInt(req.params.id);

    const sql = `DELETE FROM comments WHERE id = ?`;
    db.query(sql, [commentId], (error, result) => {
        if (error) {
            return res.status(500).send({ status: false, message: "Erro ao deletar comentário" });
        }
        res.send({ status: true, message: "Comentário deletado com sucesso" });
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

    const deleteTagsSql = "DELETE FROM post_tags WHERE post_id = ?";
    const deletePostSql = "DELETE FROM posts WHERE id = ?";

    db.query(deleteTagsSql, [postId], (err) => {
        if (err) return res.status(500).send({ status: false, message: "Erro ao remover tags do post" });

        db.query(deletePostSql, [postId], (err2) => {
            if (err2) return res.status(500).send({ status: false, message: "Erro ao deletar post" });

            res.send({ status: true, message: "Post deletado com sucesso" });
        });
    });
});

//buscars todas as tags
server.get("/api/tags", (req, res) => {
    const search = req.query.search || '';
    const likeSearch = `%${search}%`;

    let sql = `
      SELECT pt.tag, COUNT(*) AS count
      FROM post_tags pt
      JOIN posts p ON pt.post_id = p.id
      WHERE p.is_draft = 0
    `;
    let params = [];

    if (search) {
        sql += " AND pt.tag LIKE ?";
        params.push(likeSearch);
    }

    sql += " GROUP BY pt.tag ORDER BY count DESC";

    db.query(sql, params, (error, result) => {
        if (error) {
            console.error("Erro ao buscar tags:", error);
            return res.status(500).send({ status: false, message: "Erro ao buscar tags" });
        }
        res.send({ status: true, data: result });
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
        res.send({ status: true });
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

    console.log("Dados recebidos para salvar:", user_id, post_id); // ADICIONE ISSO

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
             u.profile_pic
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