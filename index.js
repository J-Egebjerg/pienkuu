"use strict";

// Configuration
let globalIgnoreFilters = [
	"*/.git/**",
	"*/pienkuu.json"
];

// Requires
let Promise = require("bluebird");
let fs = require('fs');
let minimatch = require("minimatch");
let Zip = require('node-zip');
let recursiveReaddirSync = require('recursive-readdir-sync');
let luamin = require('luamin');

// Command line arguments
let argv = require('minimist')(process.argv.slice(2));

let sourceFolderName = argv._[0];
if (!sourceFolderName) {
	console.warn("Please provide a folder name as the first argument.");
	process.exit(1);
}

let outputFileName = sourceFolderName + ".zip";

// Remove old output file if it exists
try {
	fs.unlinkSync(outputFileName);
} catch (ignored) {}

// Create new output zip
let zip = new Zip();
addFolder(sourceFolderName, zip)
	.then(function() { // we're done! write the zip file
		fs.writeFileSync(outputFileName, zip.generate({base64: false, compression: 'DEFLATE'}), "binary");
	}, function(e) { // something failed; abort
		console.warn(e);
		process.exit(1);
	});

// Fetches configuration file and returns it as JS object if found. Exits process if there are errors.
function fetchFolderConfig(folderName) {
	let readFilePromise = Promise.promisify(fs.readFile);
	return readFilePromise(folderName + "/pienkuu.json", "utf8").then(function(str) {
		return JSON.parse(str);
	});
}

// Adds given folder to given zip file.
// Automatically processes configuration file in the folder.
function addFolder(folderName, zip) {
	let config;
	return fetchFolderConfig(folderName).then(function(_config) {
		config = _config;

		// Add dependencies
		return Promise.all(
			(config.dependencies || []).map(function(depFolderName) {
				return addFolder(depFolderName, zip);
			})
		);
	}).then(function(deps) {
		// Turn config ignore paths from local to module to local to the whole zip
		let configIgnoreFilters = (config.ignore || []).map(function(path) {
			return folderName + "/" + path;
		});

		let ignoreFilters = globalIgnoreFilters.concat(configIgnoreFilters);

		// (White)list of items that will be minified. Again turned into local to whole zip paths
		let minifyList = (config.minify || []).map(function(path) {
			return folderName + "/" + path;
		});

		// List of actions that should be executed after processing folder files
		let actionList = (config.actions || []);

		recursiveReaddirSync(folderName)
			.filter(function(path) { // filter files on the ignore list
				return ignoreFilters.every(function(filter) {
					return !minimatch(path, filter, {dot: true});
				});
			})
			.map(function(path) { // convert paths to [path, contents] tuples
				let minify = minifyList.some(function(filter) { return minimatch(path, filter); });

				let contents;
				if (minify) {
					let contentsUTF = fs.readFileSync(path, "utf8");
					let minified = luamin.minify(contentsUTF);
					contents = new Buffer(minified);
				} else {
					contents = fs.readFileSync(path);
				}

				return [path, contents];
			})
			.forEach(function(pathContentTuple) { // write tuples into the zip file
				zip.file(pathContentTuple[0], pathContentTuple[1]);
			});

		return Promise.each(actionList, function(action) {
			// action is an array where first value is a string identifier and second is object of options
			let actionName = action[0];
			let actionOpts = action[1] || {};
			return applyAction(actionName, actionOpts, {
				folderName: folderName,
				zip: zip,
				config: config
			});
		});
	});
}

function applyAction(name, actionOpts, opts) {
	if (name == "print") {
		return new Promise(function(resolve) {
			console.log(opts.folderName + ": " + actionOpts.text);
			resolve();
		});
	} else if (name == "download") {
		return new Promise(function(resolve) {
			let needle = require('needle');

			needle.get(actionOpts.url, {follow: 3, decode: false, parse: false}, function(error, response) {
				let path = require('path');

				// convert to folder-relative path
				let fullPath = opts.folderName + '/' + actionOpts.target;

				if (fullPath.endsWith('/')) { // is a folder
					let fileName = path.basename(actionOpts.url);
					fullPath = fullPath + fileName;
				}

				opts.zip.file(fullPath, response.body);
				resolve();
			});
		})
	} else {
		return Promise.reject("Invalid action name '" + name + "' in '" + opts.folderName + "/pienkuu.json': no handler for action found.");
	}
}
