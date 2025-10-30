# Multi-scale Image Projection

A multi-scale image projection visualization system based on FastAPI and React, supporting interactive browsing and analysis of large-scale image data.

## System Requirements

- Python 3.11+
- Node.js 18+
- Conda (recommended) or pip

## Installation

### Backend Installation (Python)

#### Method: Using Conda (Recommended)

1. **Install Conda**
   - Download and install [Anaconda](https://www.anaconda.com/products/distribution) or [Miniconda](https://docs.conda.io/en/latest/miniconda.html)

2. **Create and activate environment**
   ```bash
   # Create conda environment
   conda env create -f environment.yml
   
   # Activate environment
   conda activate multiscale
   ```

### Frontend Installation (Node.js)
1. **Install node.js**
https://nodejs.org/en/download


2. **Install Node.js dependencies**
   ```bash
   npm install
   ```

## Running the Project

### 1. Start Backend Service

```bash
# Make sure conda environment is activated
conda activate multiscale

# Start FastAPI server
python main.py
```

Backend service will start at `http://localhost:8000`

### 2. Start Frontend Service

In a new terminal window:

```bash
# Start React development server
npm start
```

Frontend application will start at `http://localhost:3000`

### 3. Access the Application

- **Frontend Interface**: http://localhost:3000
- **Backend API**: http://localhost:8000
- **API Documentation**: http://localhost:8000/docs

## Data Preparation

Before using the application, you need to prepare the following data files:

1. **Zarr data file**: Compressed file containing image data
2. **CSV data file**: File containing coordinates and metadata information

### CSV Data Format

The CSV file should contain the following columns in order:

- `cellid`: Unique identifier for each cell
- `X_centroid`: X coordinate of cell centroid
- `Y_centroid`: Y coordinate of cell centroid  
- `name`: Cell name or label
- `umap2_x`: UMAP 2D X coordinate
- `umap2_y`: UMAP 2D Y coordinate
- `umap3_x`: UMAP 3D X coordinate
- `umap3_y`: UMAP 3D Y coordinate
- `umap3_z`: UMAP 3D Z coordinate
- `[channel_name_1]`, `[channel_name_2]`, ...: Channel data columns (ordered by channel sequence)

The channel columns should match the order of channels in the Zarr data file.

## Project Structure

```
Multi_scale_image_projection/
├── main.py                 # FastAPI backend main file
├── requirements.txt        # Python dependencies
├── environment.yml         # Conda environment configuration
├── package.json           # Node.js dependencies
├── public/                # Static files and data directory
│   ├── output.zarr/       # Zarr data files
│   ├── data.csv          # CSV data files
│   └── cache/            # Cache directory
└── src/                   # React frontend source code
    ├── App.jsx           # Main application component
    ├── Viewer/           # Image viewer component
    ├── Control/          # Control panel component
    └── ...
```

## License

MIT License