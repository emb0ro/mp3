/*
 * Connect all of your endpoints together here.
 */

var User = require('../models/user');
var Task = require('../models/task')
var mongoose = require('mongoose');

function parseJSON(value) {
    try {
        return JSON.parse(value);
    } catch (error) {
        throw new SyntaxError('Invalid query parameters');
    }
}

function parseQuery(req) {
    const query = {};
    for (const key of ['where', 'sort', 'select']) {
        if (req.query[key] !== undefined) {
            query[key] = parseJSON(req.query[key]);
            if (query[key] === null || typeof query[key] !== 'object' || Array.isArray(query[key])) {
                throw new SyntaxError('Invalid query parameters');
            }
        }
    }

    for (const key of ['skip', 'limit']) {
        if (req.query[key] !== undefined) {
            query[key] = parseJSON(req.query[key]);
            if (!Number.isInteger(query[key]) || query[key] < 0) {
                throw new SyntaxError('Invalid query parameters');
            }
        }
    }
    
    if (req.query.count !== undefined) {
        query.count = parseJSON(req.query.count);
        if (typeof query.count !== 'boolean') {
            throw new SyntaxError('Invalid query parameters');
        }
    }
    return query;
}

async function getDocuments(Model, req, defaultLimit) {
    const params = parseQuery(req);
    const where = params.where || {};
    if (params.count === true) {
        return await Model.countDocuments(where);
    }

    let query = Model.find(where);
    if (params.sort !== undefined) {
        query = query.sort(params.sort);
    }
    if (params.select !== undefined) {
        query = query.select(params.select);
    }
    if (params.skip !== undefined) {
        query = query.skip(params.skip);
    }
    if (params.limit !== undefined) {
        query = query.limit(params.limit);
    } else if (defaultLimit !== null) {
        query = query.limit(defaultLimit);
    }

    return await query.exec();
}
async function validatePendingTasks(taskIds) {
    if (!Array.isArray(taskIds)) {
        return { status: 400, message: 'Invalid pending tasks' };
    }

    const seen = new Set();

    for (const id of taskIds) {
        if (typeof id !== 'string' || !mongoose.isValidObjectId(id)) {
            return { status: 400, message: 'Invalid task ID' };
        }
        if (seen.has(id.toLowerCase())) {
            return { status: 400, message: 'Duplicate task ID'};
        }
        seen.add(id.toLowerCase());
        const task = await Task.findById(id);
        if (!task) {
            return { status: 404, message: 'Task not found' };
        }
        if (task.completed) {
            return { status: 400, message: 'Task is already completed' };
        }
    }
    return null;
}

async function updateUserTasks(user, pendingTasks, name, session) {
    const userId = user._id.toString();
    await Task.updateMany(
        {
            assignedUser: userId,
            completed: false,
            _id: { $nin: pendingTasks }
        },
        {
            $set: {
                assignedUser: '',
                assignedUserName: 'unassigned'
            }
        },
        { session }
    );
    await User.updateMany(
        { _id: { $ne: user._id } },
        { $pull: { pendingTasks: { $in: pendingTasks } } },
        { session }
    );

    await Task.updateMany(
        { _id: { $in: pendingTasks } },
        {
            $set: {
                assignedUser: userId,
                assignedUserName: name
            }
        },
        { session }
    );

    await Task.updateMany(
        { assignedUser: userId },
        { $set: { assignedUserName: name } },
        { session }
    );
}
module.exports = function (app, router) {
    router.get('/users', async function(req, res) {
        try {
            const users = await getDocuments(User, req, null);

            res.status(200).json({
                message: 'OK',
                data: users
            });
        } catch (error) {
            console.error('Error retrieving user:', error);
            res.status(error instanceof SyntaxError ? 400 : 500).json({
                message: error instanceof SyntaxError ? 'Invalid query parameters' : 'Unable to retrieve user',
                data: null
            });
        }
    })
    router.get('/tasks', async function(req, res) {
        try {
            const tasks = await getDocuments(Task, req, 100);
            res.status(200).json({
                message: 'OK',
                data: tasks
            });
        } catch (error) {
            console.error('Error retrieving tasks:', error);
            res.status(error instanceof SyntaxError ? 400 : 500).json({
                message: error instanceof SyntaxError ? 'Invalid query parameters' : 'Unable to retrieve tasks',
                data: null
            });
        }
    });
    router.get('/users/:id', async function(req, res) {
        try {
            if (!mongoose.isValidObjectId(req.params.id)) {
                return res.status(404).json({
                    message: 'User not found',
                    data: null
                });
            }
            let query = User.findById(req.params.id);
            if (req.query.select !== undefined) {
                const params = parseQuery(req);
                query = query.select(params.select);
            }
            const user = await query.exec();
            if (!user) {
                return res.status(404).json({
                    message: 'User not found',
                    data: null
                });
            }
            res.status(200).json({
                message: 'OK',
                data: user
            });
            // Copilot auto-filled repeated error lines (193-198, 225-30)
        } catch (error) {
            console.error('Error retrieving user:', error);
            res.status(error instanceof SyntaxError ? 400 : 500).json({
                message: error instanceof SyntaxError ? 'Invalid query parameters' : 'Unable to retrieve user',
                data: null
            });
        }
    });
    router.get('/tasks/:id', async function(req, res) {
        try {
            if (!mongoose.isValidObjectId(req.params.id)) {
               return res.status(404).json({
                    message: 'Task not found',
                    data: null
                }); 
            }
            let query = Task.findById(req.params.id);
            if (req.query.select !== undefined) {
                const params = parseQuery(req);
                query = query.select(params.select);
            }
            const task = await query.exec();
            if (!task) {
                return res.status(404).json({
                    message: 'Task not found',
                    data: null
                });
            }
            res.status(200).json({
                message: 'OK',
                data: task
            });
        } catch (error) {
            console.error('Error retrieving task:', error);
            res.status(error instanceof SyntaxError ? 400 : 500).json({
                message: error instanceof SyntaxError ? 'Invalid query parameters' : 'Unable to retrieve task',
                data: null
            });
        }
    });

    router.post('/users', async function(req, res) {
        try {
            const { name, email, pendingTasks } = req.body;
            if (typeof name !== 'string' || !name.trim() || typeof email !== 'string' || !email.trim()) {
                return res.status(400).json({
                    message: 'Name and email are required',
                    data: null
                });
            }
            const existing = await User.findOne({ email: email });
            if (existing) {
                return res.status(400).json({
                    message: 'This email is already associated with an account',
                    data: null
                });
            }
            const tasks = pendingTasks === undefined ? [] : pendingTasks;
            const taskError = await validatePendingTasks(tasks);
            if (taskError) {
                return res.status(taskError.status).json({
                    message: taskError.message,
                    data: null
                });
            }
            const user = new User({
                name: name,
                email: email,
                pendingTasks: tasks
            });
            const session = await mongoose.startSession();
            try {
                await session.withTransaction(async function() {
                    await user.save({ session });
                    await updateUserTasks(user, tasks, name, session);
                });
            } finally {
                await session.endSession();
            }

            res.status(201).json({
                message: 'User successfully created',
                data: user
            });
        } catch (error) {
            console.error('Error creating user:', error);
            if (error.code === 11000) {
                return res.status(400).json({
                    message: 'This email is already in use',
                    data: null
                });
            }
            res.status(500).json({
                message: 'Unable to create user',
                data: null
            });
        }
    });

    router.post('/tasks', async function(req, res) {
        try {
            const {
                name,
                description,
                deadline,
                completed,
                assignedUser,
                assignedUserName
            } = req.body;

            if (typeof name !== 'string' || !name.trim() || typeof deadline !== 'string' || !deadline.trim()
                || isNaN(Date.parse(deadline))) {
                    return res.status(400).json({
                        message: 'Needs valid name and deadline',
                        data: null
                    });
            }
            if ((description !== undefined && typeof description !== 'string') || (completed !== undefined
                && typeof completed !== 'boolean')) {
                    return res.status(400).json({
                        message: 'Invalid task types',
                        data: null
                    });
                }
            let user = null;
            if (assignedUser !== undefined && assignedUser !== '') {
                if (typeof assignedUser !== 'string' || !mongoose.isValidObjectId(assignedUser)) {
                    return res.status(400).json({
                        message: 'Invalid user ID',
                        data: null
                    });
                }
                user = await User.findById(assignedUser);

                if (!user) {
                    return res.status(404).json({
                        message: 'User not found',
                        data: null
                    });
                }
                if (assignedUserName !== undefined && assignedUserName !== user.name) {
                    return res.status(400).json({
                        message: 'Invalid assigned username',
                        data: null
                    });
                }
            } else if (assignedUserName !== undefined && assignedUserName !== 'unassigned') {
                return res.status(400).json({
                    message: 'Invalid assigned username',
                    data: null
                });
            }
        
            const task = new Task({
                name: name,
                description: description === undefined ? '' : description,
                deadline: deadline,
                completed: completed === undefined ? false : completed,
                assignedUser: user ? user._id.toString() : '',
                assignedUserName: user ? user.name : 'unassigned'
            });
            const session = await mongoose.startSession();

            try {
                await session.withTransaction(async function() {
                    await task.save({ session });
                    if (user && !task.completed) {
                        await User.updateOne(
                            { _id: user._id },
                            { $addToSet: { pendingTasks: task._id.toString() } },
                            { session }
                        );
                    }
                });
            } finally {
                await session.endSession();
            }

            res.status(201).json({
                message: 'Task created successfully',
                data: task
            });
        } catch (error) {
            console.error('Error creating task:', error);
            res.status(500).json({
                message: 'Cannot create task',
                data: null
            });
        }
    });

    router.put('/users/:id', async function(req, res) {
        try {
            const id = req.params.id;
            const { name, email, pendingTasks = [] } = req.body;
            if (!mongoose.isValidObjectId(id)) {
                return res.status(404).json({
                    message: 'User not found',
                    data: null
                });
            }
            const user = await User.findById(id);

            if (!user) {
                return res.status(404).json({
                    message: 'User not found',
                    data: null
                });
            }

            if (typeof name !== 'string' || !name.trim() || typeof email !== 'string' || !email.trim()) {
                return res.status(400).json({
                    message: 'Invalid name or email',
                    data: null
                });
            }
            const existing = await User.findOne({ email: email });

            if (existing && existing._id.toString() !== id) {
                return res.status(400).json({
                    message: 'Email already exists',
                    data: null
                });
            }

            const taskError = await validatePendingTasks(pendingTasks);
            if (taskError) {
                return res.status(taskError.status).json({
                    message: taskError.message,
                    data: null
                });
            }
            const session = await mongoose.startSession();
            try {
                await session.withTransaction(async function() {
                    await updateUserTasks(user, pendingTasks, name, session);
                    user.name = name;
                    user.email = email;
                    user.pendingTasks = pendingTasks;
                    await user.save({ session });
                });
            } finally {
                await session.endSession();
            }

            res.status(200).json({
                message: 'User updated successfully',
                data: user
            });

        } catch (error) {
            console.error('Error updating user:', error);
            if (error.code === 11000) {
                return res.status(400).json({
                    message: 'Email already exists',
                    data: null
                });
            }
            res.status(500).json({
                message: 'Unable to update user',
                data: null
            });
        }
    });

    router.put('/tasks/:id', async function(req, res) {
        try {
            const id = req.params.id;
            if (!mongoose.isValidObjectId(id)) {
                return res.status(404).json({
                    message: 'Task not found',
                    data: null
                });
            }
            const task = await Task.findById(id);

            if (!task) {
                return res.status(404).json({
                    message: 'Task not found',
                    data: null
                });
            }
            const {
                name,
                description = '',
                deadline,
                completed = false,
                assignedUser = '',
                assignedUserName
            } = req.body;

            if (typeof name !== 'string' || !name.trim() || typeof deadline !== 'string' || !deadline.trim()
                || isNaN(Date.parse(deadline))) {
                return res.status(400).json({
                    message: 'Invalid name or deadline',
                    data: null
                });
            }
            if (typeof description !== 'string' || typeof completed !== 'boolean' || typeof assignedUser !== 'string') {
                return res.status(400).json({
                    message: 'Invalid task fields',
                    data: null
                });
            }
            let user = null;
            if (assignedUser !== '') {
                if (!mongoose.isValidObjectId(assignedUser)) {
                    return res.status(400).json({
                        message: 'Invalid user ID',
                        data: null
                    });
                }
                user = await User.findById(assignedUser);

                if (!user) {
                    return res.status(404).json({
                        message: 'User not found',
                        data: null
                    });
                }

                if (assignedUserName !== undefined && assignedUserName !== user.name) {
                    return res.status(400).json({
                        message: 'Invalid assigned username',
                        data: null
                    });
                }
            } else if (assignedUserName !== undefined && assignedUserName !== 'unassigned') {
                return res.status(400).json({
                    message: 'Invalid assigned username',
                    data: null
                });
            }

            const session = await mongoose.startSession();

            try {
                await session.withTransaction(async function() {
                    await User.updateMany(
                        { pendingTasks: id },
                        { $pull: { pendingTasks: id } },
                        { session }
                    );

                    if (user && !completed) {
                        await User.updateOne(
                            { _id: user._id },
                            { $addToSet: { pendingTasks: id } },
                            { session }
                        );
                    }
                    task.name = name;
                    task.description = description;
                    task.deadline = deadline;
                    task.completed = completed;
                    task.assignedUser = user ? user._id.toString() : '';
                    task.assignedUserName = user ? user.name : 'unassigned';
                    await task.save({ session });
                });
            } finally {
                await session.endSession();
            }
            res.status(200).json({
                message: 'Task updated successfully',
                data: task
            });
        } catch (error) {
            console.error('Error updating task:', error);
            res.status(500).json({
                message: 'Unable to update task',
                data: null
            });
        }
    });

    router.delete('/tasks/:id', async function(req, res) {
        try {
            const id = req.params.id;
            if (!mongoose.isValidObjectId(id)) {
                return res.status(404).json({
                    message: 'Task not found',
                    data: null
                });
            }
            const session = await mongoose.startSession();
            let deletedTask;
            try {
                await session.withTransaction(async function() {
                    deletedTask = await Task.findByIdAndDelete(id, { session });
                    if (!deletedTask) {
                        return;
                    }
                    await User.updateMany(
                        { pendingTasks: id },
                        { $pull: { pendingTasks: id } },
                        { session }
                    );
                });
            } finally {
                await session.endSession();
            }
            if (!deletedTask) {
                return res.status(404).json({
                    message: 'Task not found',
                    data: null
                });
            }
            return res.status(204).send();
        } catch (error) {
            console.error('Error deleting task', error);
            return res.status(500).json({
                message: 'Unable to delete task',
                data: null
            });
        }
    });

    router.delete('/users/:id', async function(req, res) {
        try {
            const id = req.params.id;
            if (!mongoose.isValidObjectId(id)) {
                return res.status(404).json({
                    message: 'User not found',
                    data: null
                });
            }
            const session = await mongoose.startSession();
            let deletedUser;
            try {
                await session.withTransaction(async function() {
                    deletedUser = await User.findByIdAndDelete(id, { session });
                    if (!deletedUser) {
                        return;
                    }
                    await Task.updateMany(
                        { assignedUser: id },
                        { $set: {
                            assignedUser: '',
                            assignedUserName: 'unassigned'
                        } },
                        { session }
                    );
                });
            } finally {
                await session.endSession();
            }
            if (!deletedUser) {
                return res.status(404).json({
                    message: 'User not found',
                    data: null
                });
            }
            return res.status(204).send();
        } catch (error) {
            console.error('Error deleting user', error);
            return res.status(500).json({
                message: 'Unable to delete user',
                data: null
            });
        }
    });

    
    app.use('/api', require('./home.js')(router));
};
