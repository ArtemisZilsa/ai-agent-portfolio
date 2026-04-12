import anthropic
import json
from datetime import datetime

client = anthropic.Anthropic()

# ============================================
# TOOLS — 3 tools yang sama, konteks berbeda
# ============================================
tools = [
    {
        "name": "read_brief",
        "description": "Membaca file brief atau notes dari user. Gunakan ini jika user menyebut file atau catatan yang perlu dibaca.",
        "input_schema": {
            "type": "object",
            "properties": {
                "file_path": {
                    "type": "string",
                    "description": "Path ke file brief yang akan dibaca"
                }
            },
            "required": ["file_path"]
        }
    },
    {
        "name": "search_content_data",
        "description": "Mencari data, tren, dan referensi untuk topik konten tertentu. Gunakan ini untuk mencari angle konten, audience insights, dan keyword.",
        "input_schema": {
            "type": "object",
            "properties": {
                "topic": {
                    "type": "string",
                    "description": "Topik utama yang ingin diriset"
                },
                "search_type": {
                    "type": "string",
                    "enum": ["trends", "audience", "competitors", "keywords", "angles"],
                    "description": "Jenis data yang dicari"
                }
            },
            "required": ["topic", "search_type"]
        }
    },
    {
        "name": "save_research_brief",
        "description": "Menyimpan hasil riset ke file JSON yang terstruktur dan siap dipakai untuk membuat konten.",
        "input_schema": {
            "type": "object",
            "properties": {
                "topic": {
                    "type": "string",
                    "description": "Topik konten"
                },
                "brief_data": {
                    "type": "object",
                    "description": "Data brief lengkap dalam format terstruktur"
                }
            },
            "required": ["topic", "brief_data"]
        }
    }
]

# ============================================
# FUNGSI TOOLS
# ============================================
def read_brief(file_path):
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            return f.read()
    except Exception as e:
        return f"File tidak ditemukan: {str(e)}"

def search_content_data(topic, search_type):
    """
    Saat ini: mock database
    Nanti bisa diganti: Google Trends API, YouTube API, dll
    """
    mock_data = {
        "trends": {
            "Claude Code": "Trending di developer community, naik 300% pencarian sejak Maret 2025. Topik terkait: AI coding, vibe coding, autonomous coding agent.",
            "AI Agent": "Salah satu keyword terpanas di tech 2025. Banyak dicari oleh developer dan non-developer.",
            "Context Engineering": "Viral sejak pertengahan 2025 setelah tweet Karpathy. Masih sangat underserved di konten Indonesia."
        },
        "audience": {
            "Claude Code": "Developer junior yang mau produktif, freelancer tech, orang yang belajar coding. Pain point: terlalu lama debug, tidak tahu cara otomasi.",
            "AI Agent": "Business owner, freelancer, content creator yang mau otomasi workflow mereka.",
            "Context Engineering": "AI engineer, developer senior, peneliti. Mencari pemahaman lebih dalam dari sekadar prompt."
        },
        "angles": {
            "Claude Code": [
                "Cara Claude Code bisa gantikan 3 jam kerja manual jadi 10 menit",
                "Pemula bisa otomasi pekerjaan mereka dengan Claude Code tanpa coding dari nol",
                "5 workflow yang bisa diotomasi Claude Code hari ini",
                "Claude Code vs Cursor — mana yang lebih cocok untuk freelancer?",
                "Dari nol ke tool pertama: pengalaman nyata belajar Claude Code"
            ],
            "AI Agent": [
                "AI Agent untuk pemula — dari konsep ke implementasi dalam 1 hari",
                "Berapa penghasilan freelancer AI Agent di 2025?",
                "5 bisnis kecil yang sudah pakai AI Agent dan hasilnya",
                "Bedanya chatbot biasa vs AI Agent yang bisa action",
                "Tutorial: Build AI Agent pertamamu dalam 4 jam"
            ]
        },
        "keywords": {
            "Claude Code": ["claude code tutorial", "AI coding tool", "otomasi dengan AI", "belajar claude code", "AI untuk developer"],
            "AI Agent": ["AI agent indonesia", "buat AI agent", "otomasi bisnis AI", "cara kerja AI agent", "AI agent untuk pemula"]
        },
        "competitors": {
            "Claude Code": "Konten Indonesia tentang Claude Code masih sangat sedikit. Peluang besar untuk jadi referensi utama.",
            "AI Agent": "Sudah ada beberapa creator membahas, tapi kebanyakan pakai framework berat seperti LangChain. Celah: konten yang simple dan praktis."
        }
    }

    topic_key = None
    for key in mock_data[search_type]:
        if key.lower() in topic.lower():
            topic_key = key
            break

    if topic_key:
        result = mock_data[search_type][topic_key]
        return json.dumps(result, ensure_ascii=False)
    return f"Data untuk '{topic}' belum ada di database. Gunakan data umum untuk topik AI."

def save_research_brief(topic, brief_data):
    timestamp = datetime.now().strftime("%Y%m%d_%H%M")
    filename = f"brief_{topic.replace(' ', '_').lower()}_{timestamp}.json"

    output = {
        "generated_at": datetime.now().isoformat(),
        "topic": topic,
        "brief": brief_data
    }

    with open(filename, 'w', encoding='utf-8') as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    return f"Brief tersimpan di: {filename}"

# ============================================
# ROUTER
# ============================================
def execute_tool(tool_name, tool_input):
    if tool_name == "read_brief":
        return read_brief(tool_input["file_path"])
    elif tool_name == "search_content_data":
        return search_content_data(
            tool_input["topic"],
            tool_input["search_type"]
        )
    elif tool_name == "save_research_brief":
        return save_research_brief(
            tool_input["topic"],
            tool_input["brief_data"]
        )
    return "Tool tidak dikenal"

# ============================================
# AGENT LOOP
# ============================================
def run_content_agent(request):
    print(f"\n{'='*50}")
    print(f"REQUEST: {request}")
    print(f"{'='*50}")

    system_prompt = """Kamu adalah Content Research Agent yang membantu content creator
    membuat riset konten yang mendalam dan terstruktur.

    Untuk setiap request riset:
    1. Cari data trends untuk topik tersebut
    2. Cari audience insights
    3. Cari angle konten yang menarik
    4. Cari keywords relevan
    5. Simpan semua dalam brief yang terstruktur

    Selalu simpan hasil akhir sebagai file menggunakan save_research_brief."""

    messages = [{"role": "user", "content": request}]

    while True:
        response = client.messages.create(
            model="claude-sonnet-4-20250514",
            max_tokens=2048,
            system=system_prompt,
            tools=tools,
            messages=messages
        )

        if response.stop_reason == "end_turn":
            print("\n--- OUTPUT AGENT ---")
            for block in response.content:
                if hasattr(block, 'text'):
                    print(block.text)
            break

        if response.stop_reason == "tool_use":
            messages.append({
                "role": "assistant",
                "content": response.content
            })

            tool_results = []
            for block in response.content:
                if block.type == "tool_use":
                    print(f"\n[→] Tool: {block.name}")
                    print(f"    Input: {json.dumps(block.input, ensure_ascii=False)[:100]}")

                    result = execute_tool(block.name, block.input)
                    print(f"    Output: {str(result)[:100]}...")

                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": result
                    })

            messages.append({
                "role": "user",
                "content": tool_results
            })

# ============================================
# JALANKAN
# ============================================
if __name__ == "__main__":

    # TEST 1 — riset topik tunggal
    run_content_agent(
        "Buatkan riset lengkap untuk konten tentang Claude Code. "
        "Aku butuh angle, audience, dan keywords yang bisa langsung dipakai."
    )

    # TEST 2 — riset untuk topik yang lebih luas
    run_content_agent(
        "Riset topik AI Agent untuk konten YouTube bahasa Indonesia. "
        "Fokus ke pemula yang belum pernah dengar AI Agent sebelumnya."
    )
