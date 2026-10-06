const Settings = require('../models/Settings');

const getSettings = async () => {
  let settings = await Settings.findOne().lean();
  if (!settings) {
    settings = await Settings.create({});
    settings = settings.toObject();
  }
  delete settings.updatedBy;
  delete settings.createdAt;
  delete settings.updatedAt;
  delete settings.__v;
  delete settings._id;
  return settings;
};

exports.getPublicSettings = async (req, res, next) => {
  try {
    res.json({
      success: true,
      data: await getSettings(),
    });
  } catch (error) {
    next(error);
  }
};

exports.getSettings = getSettings;